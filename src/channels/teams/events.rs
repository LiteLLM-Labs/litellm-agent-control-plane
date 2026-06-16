use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::{json, Value};

use crate::{
    db::managed_agents::registry::schema::ManagedAgentRow, errors::GatewayError,
    http::sessions::create_runtime_session_for_agent_without_prompt, proxy::state::AppState,
    sdk::agents::CLAUDE_MANAGED_AGENTS,
};

use super::{
    auth,
    config::{load_agent, teams_config},
    reply::spawn_teams_prompt,
    repository,
    session_lock::TeamsConversationLock,
    types::{TeamsActivity, TeamsChannelAccount, TeamsIncomingMessage},
};

pub(crate) async fn messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Json(activity): Json<TeamsActivity>,
) -> Result<StatusCode, GatewayError> {
    let pool = state
        .db
        .as_ref()
        .ok_or(GatewayError::MissingDatabase)?
        .clone();
    let agent = load_agent(&pool, &agent_id).await?;
    let config = teams_config(&agent)?;
    let Some(app_id) = config
        .app_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err(GatewayError::InvalidConfig(
            "teams app_id is not configured".to_owned(),
        ));
    };
    let service_url = activity_endpoint(&activity)?;
    auth::verify_connector_request(
        &state.http,
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
        app_id,
        &service_url,
    )
    .await?;
    let message = match incoming_message(activity, service_url) {
        Some(message) => message,
        None => return Ok(StatusCode::OK),
    };
    let _conversation_lock =
        TeamsConversationLock::acquire(&state.keyed_locks, &agent.id, &message.conversation_id)
            .await;
    let session_id = ensure_session(state.clone(), &pool, &agent, &message).await?;
    if !repository::record_event(&pool, &agent.id, &event_key(&message)).await? {
        return Ok(StatusCode::OK);
    }
    spawn_teams_prompt(state, pool, agent, config, message, session_id);
    Ok(StatusCode::ACCEPTED)
}

async fn ensure_session(
    state: Arc<AppState>,
    pool: &sqlx::PgPool,
    agent: &ManagedAgentRow,
    message: &TeamsIncomingMessage,
) -> Result<String, GatewayError> {
    if let Some(session_id) = refresh_existing_session(pool, agent, message).await? {
        return Ok(session_id);
    }
    let session_id = create_session(state, pool, agent, message).await?;
    upsert_session(pool, agent, message, &session_id).await
}

async fn refresh_existing_session(
    pool: &sqlx::PgPool,
    agent: &ManagedAgentRow,
    message: &TeamsIncomingMessage,
) -> Result<Option<String>, GatewayError> {
    let Some(row) = repository::get(pool, &agent.id, &message.conversation_id).await? else {
        return Ok(None);
    };
    Ok(Some(
        upsert_session(pool, agent, message, &row.session_id).await?,
    ))
}

async fn create_session(
    state: Arc<AppState>,
    pool: &sqlx::PgPool,
    agent: &ManagedAgentRow,
    message: &TeamsIncomingMessage,
) -> Result<String, GatewayError> {
    create_runtime_session_for_agent_without_prompt(
        state,
        pool,
        agent.id.clone(),
        agent_runtime(agent),
        session_title(message),
        session_metadata(message),
    )
    .await
}

async fn upsert_session(
    pool: &sqlx::PgPool,
    agent: &ManagedAgentRow,
    message: &TeamsIncomingMessage,
    session_id: &str,
) -> Result<String, GatewayError> {
    let row = repository::upsert(
        pool,
        repository::UpsertConversationInput {
            agent_id: &agent.id,
            conversation_id: &message.conversation_id,
            session_id,
            service_url: &message.service_url,
            tenant_id: message.tenant_id.as_deref(),
            team_id: message.team_id.as_deref(),
            channel_id: message.teams_channel_id.as_deref(),
        },
    )
    .await?;
    Ok(row.session_id)
}

fn session_title(message: &TeamsIncomingMessage) -> String {
    format!("Teams {}", message.conversation_id)
}

fn session_metadata(message: &TeamsIncomingMessage) -> Value {
    json!({
        "source": "teams",
        "conversation_id": message.conversation_id,
        "tenant_id": message.tenant_id,
        "team_id": message.team_id,
        "channel_id": message.teams_channel_id,
        "user_id": message.user_id,
    })
}

fn incoming_message(activity: TeamsActivity, service_url: String) -> Option<TeamsIncomingMessage> {
    if activity.activity_type.as_deref() != Some("message") {
        return None;
    }
    if is_bot_message(&activity) {
        return None;
    }
    let text = clean_prompt(activity.text.as_deref().unwrap_or_default());
    let conversation_id = activity
        .conversation
        .as_ref()?
        .id
        .as_deref()?
        .trim()
        .to_owned();
    let activity_id = activity
        .id
        .as_deref()
        .or(activity.reply_to_id.as_deref())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())?;
    Some(TeamsIncomingMessage {
        activity_id,
        service_url,
        conversation_id,
        tenant_id: tenant_id(&activity),
        team_id: nested_channel_data_id(activity.channel_data.as_ref(), "team"),
        teams_channel_id: nested_channel_data_id(activity.channel_data.as_ref(), "channel"),
        user_id: activity.from.as_ref().and_then(|from| from.id.clone()),
        prompt: text,
        from: activity.from,
        recipient: activity.recipient,
    })
}

fn activity_endpoint(activity: &TeamsActivity) -> Result<String, GatewayError> {
    let channel_id = required_activity_field(activity.channel_id.as_deref(), "channelId")?;
    if channel_id != auth::TEAMS_CHANNEL_ID {
        return Err(GatewayError::Unauthorized);
    }
    required_activity_field(activity.service_url.as_deref(), "serviceUrl")
}

fn required_activity_field(value: Option<&str>, field: &str) -> Result<String, GatewayError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| GatewayError::InvalidJsonMessage(format!("teams {field} is required")))
}

fn is_bot_message(activity: &TeamsActivity) -> bool {
    let from = activity.from.as_ref();
    let role_is_bot = from
        .and_then(|account| account.role.as_deref())
        .is_some_and(|role| role.eq_ignore_ascii_case("bot"));
    let same_account = match (account_id(from), account_id(activity.recipient.as_ref())) {
        (Some(from), Some(recipient)) => from == recipient,
        _ => false,
    };
    role_is_bot || same_account
}

fn account_id(account: Option<&TeamsChannelAccount>) -> Option<&str> {
    account
        .and_then(|account| account.id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn clean_prompt(text: &str) -> String {
    let prompt = text
        .split_whitespace()
        .filter(|part| !part.starts_with("<at>") && !part.ends_with("</at>"))
        .collect::<Vec<_>>()
        .join(" ");
    match prompt.trim() {
        "" => "Proceed with your task.".to_owned(),
        value => value.to_owned(),
    }
}

fn event_key(message: &TeamsIncomingMessage) -> String {
    format!("{}:{}", message.conversation_id, message.activity_id)
}

fn tenant_id(activity: &TeamsActivity) -> Option<String> {
    activity
        .conversation
        .as_ref()
        .and_then(|conversation| conversation.tenant_id.clone())
        .or_else(|| nested_channel_data_id(activity.channel_data.as_ref(), "tenant"))
}

fn nested_channel_data_id(channel_data: Option<&Value>, field: &str) -> Option<String> {
    channel_data?
        .get(field)
        .and_then(Value::as_object)
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn agent_runtime(agent: &ManagedAgentRow) -> String {
    agent
        .config
        .get("runtime")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|runtime| !runtime.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| CLAUDE_MANAGED_AGENTS.to_owned())
}

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;
