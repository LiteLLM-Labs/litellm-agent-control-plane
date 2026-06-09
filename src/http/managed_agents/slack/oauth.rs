use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::Redirect,
    Json,
};
use serde_json::{json, Value};

use crate::{
    db::managed_agents::{
        registry::{
            self,
            schema::{ManagedAgentRow, UpdateManagedAgent},
        },
        slack,
    },
    errors::GatewayError,
    proxy::{state::AppState, vault},
};

use super::{
    config::{
        bot_token_key, client_secret_key, load_agent, load_secret, origin, provider_id_for,
        slack_config, update_slack_config,
    },
    types::{OAuthCallbackQuery, SlackAgentConfig, SlackOAuthStateResponse, DEFAULT_VAULT_USER},
    web_api,
};

pub async fn oauth_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<Json<SlackOAuthStateResponse>, GatewayError> {
    let pool = crate::http::managed_agents::db(&state, &headers)?;
    let agent = load_agent(pool, &agent_id).await?;
    let provider_id = provider_id_for(&agent.id);
    let state = slack::repository::create_oauth_state(pool, &agent.id, &provider_id).await?;
    Ok(Json(SlackOAuthStateResponse { state }))
}

pub async fn oauth_callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
    Query(query): Query<OAuthCallbackQuery>,
) -> Result<Redirect, GatewayError> {
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let oauth_state = required(query.state.as_deref(), "missing oauth state")?.to_owned();
    let agent_id = consume_state(pool, Some(&oauth_state), &provider_id).await?;
    let agent = load_agent(pool, &agent_id).await?;
    if let Some(error) = query.error.clone() {
        mark_failed(pool, &agent, error).await?;
        return Ok(Redirect::to("/agents/?slack=failed"));
    }
    complete_oauth(
        &state,
        pool,
        &headers,
        provider_id,
        oauth_state,
        query,
        agent,
    )
    .await
}

async fn complete_oauth(
    state: &AppState,
    pool: &sqlx::PgPool,
    headers: &HeaderMap,
    provider_id: String,
    oauth_state: String,
    query: OAuthCallbackQuery,
    agent: ManagedAgentRow,
) -> Result<Redirect, GatewayError> {
    let config = slack_config(&agent)?;
    let code = required(query.code.as_deref(), "missing oauth code")?;
    let client_id = required(
        config.client_id.as_deref(),
        "slack client_id is not configured",
    )?;
    let client_secret = load_secret(state, &client_secret_key(&agent.id, &config)).await?;
    let redirect_uri = format!("{}/host-oauth-callback/{provider_id}", origin(headers));
    let oauth = web_api::oauth_access(
        &state.http,
        &state.config.slack.api_base_url,
        client_id,
        &client_secret,
        code,
        &redirect_uri,
    )
    .await?;
    store_oauth_result(state, pool, &agent, &config, oauth_state, oauth).await
}

async fn store_oauth_result(
    state: &AppState,
    pool: &sqlx::PgPool,
    agent: &ManagedAgentRow,
    config: &SlackAgentConfig,
    oauth_state: String,
    oauth: web_api::SlackOAuthAccessResponse,
) -> Result<Redirect, GatewayError> {
    if !oauth.ok {
        let error = oauth.error.unwrap_or_else(|| "oauth_failed".to_owned());
        mark_failed(pool, agent, error).await?;
        return Ok(Redirect::to("/agents/?slack=failed"));
    }
    let access_token = oauth.access_token.ok_or_else(|| {
        GatewayError::InvalidConfig("slack oauth response omitted access_token".to_owned())
    })?;
    let key = bot_token_key(&agent.id, config);
    vault::save(pool, &state.config, DEFAULT_VAULT_USER, &key, &access_token).await?;
    update_slack_config(
        pool,
        agent,
        json!({
            "status": "connected",
            "bot_token_key": key,
            "slack_team_name": oauth.team.and_then(|team| team.name),
            "bot_user_id": oauth.bot_user_id,
            "oauth_error": Value::Null,
        }),
    )
    .await?;
    finish_pending_install(pool, agent, &oauth_state).await?;
    Ok(Redirect::to("/agents/?slack=connected"))
}

async fn finish_pending_install(
    pool: &sqlx::PgPool,
    platform_agent: &ManagedAgentRow,
    oauth_state: &str,
) -> Result<(), GatewayError> {
    let Some(pending) = slack::bindings::consume_pending_install(pool, oauth_state).await? else {
        return Ok(());
    };
    let platform = load_agent(pool, &platform_agent.id).await?;
    let child = load_agent(pool, &pending.agent_id).await?;
    copy_slack_config(pool, &child, &platform.config).await?;
    slack::bindings::upsert_binding(
        pool,
        slack::bindings::UpsertBindingInput {
            platform_agent_id: &pending.platform_agent_id,
            agent_id: &pending.agent_id,
            team_id: pending.team_id.as_deref(),
            channel_id: &pending.channel_id,
            thread_ts: pending.thread_ts.as_deref().unwrap_or(&pending.channel_id),
            dm_user_id: pending.dm_user_id.as_deref(),
            created_by: pending.requested_by.as_deref(),
        },
    )
    .await?;
    Ok(())
}

async fn copy_slack_config(
    pool: &sqlx::PgPool,
    child: &ManagedAgentRow,
    platform_config: &Value,
) -> Result<(), GatewayError> {
    let mut root = child.config.as_object().cloned().unwrap_or_default();
    root.insert("runtime".to_owned(), "claude_managed_agents".into());
    root.insert(
        "slack".to_owned(),
        platform_config
            .get("slack")
            .cloned()
            .unwrap_or_else(|| json!({})),
    );
    registry::repository::update(
        pool,
        &child.id,
        UpdateManagedAgent {
            name: None,
            model: None,
            runtime: None,
            system: None,
            prompt: None,
            cron: None,
            timezone: None,
            vault_keys: None,
            setup_commands: None,
            max_runtime_minutes: None,
            on_failure: None,
            config: Some(Value::Object(root)),
            owner_id: None,
            status: None,
            description: None,
            harness: Some("claude_managed_agents".to_owned()),
            skill_ids: None,
            rule_ids: None,
        },
    )
    .await?;
    Ok(())
}

async fn consume_state(
    pool: &sqlx::PgPool,
    state: Option<&str>,
    provider_id: &str,
) -> Result<String, GatewayError> {
    let state = required(state, "missing oauth state")?;
    slack::repository::consume_oauth_state(pool, state, provider_id)
        .await?
        .ok_or(GatewayError::Unauthorized)
}

async fn mark_failed(
    pool: &sqlx::PgPool,
    agent: &ManagedAgentRow,
    error: String,
) -> Result<(), GatewayError> {
    update_slack_config(
        pool,
        agent,
        json!({ "status": "oauth_failed", "oauth_error": error }),
    )
    .await
}

fn required<'a>(value: Option<&'a str>, message: &str) -> Result<&'a str, GatewayError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| GatewayError::InvalidJsonMessage(message.to_owned()))
}
