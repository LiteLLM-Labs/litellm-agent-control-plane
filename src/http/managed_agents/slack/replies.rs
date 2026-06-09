use std::sync::Arc;

use sqlx::PgPool;
use tracing::warn;

use crate::{
    db::managed_agents::registry::schema::ManagedAgentRow,
    errors::GatewayError,
    http::platform_mcps::factory_slack_app,
    http::sessions::{enqueue_prompt_text, runtime_event_stream_for_session},
    proxy::state::AppState,
};

use super::{
    config::{bot_token_key, load_secret},
    reply_lock::SlackPromptLock,
    reply_storage::last_message_seq,
    reply_stream::{SlackReply, SlackReplyParams},
    types::{SlackAgentConfig, SlackIncomingMessage},
    web_api,
};

pub(super) fn spawn_slack_prompt(
    state: Arc<AppState>,
    pool: PgPool,
    agent: ManagedAgentRow,
    config: SlackAgentConfig,
    message: SlackIncomingMessage,
    session_id: String,
) {
    tokio::spawn(async move {
        if let Err(error) = run_slack_prompt(state, pool, agent, config, message, session_id).await
        {
            warn!("slack prompt failed: {error}");
        }
    });
}

async fn run_slack_prompt(
    state: Arc<AppState>,
    pool: PgPool,
    agent: ManagedAgentRow,
    config: SlackAgentConfig,
    message: SlackIncomingMessage,
    session_id: String,
) -> Result<(), GatewayError> {
    let bot_token = load_secret(&state, &bot_token_key(&agent.id, &config)).await?;
    if let Err(error) = web_api::add_reaction(
        &state.http,
        &state.config.slack.api_base_url,
        &bot_token,
        &message.channel,
        &message.reply_thread_ts,
        "eyes",
    )
    .await
    {
        warn!("slack eyes reaction failed: {error}");
    }
    let _lock = SlackPromptLock::acquire(&state.keyed_locks, &session_id).await;
    run_locked_slack_prompt(state, &pool, agent, config, message, session_id, bot_token).await
}

async fn run_locked_slack_prompt(
    state: Arc<AppState>,
    pool: &PgPool,
    agent: ManagedAgentRow,
    config: SlackAgentConfig,
    message: SlackIncomingMessage,
    session_id: String,
    bot_token: String,
) -> Result<(), GatewayError> {
    let baseline_seq = last_message_seq(pool, &session_id).await?;
    let runtime_stream = runtime_event_stream_for_session(&state, pool, &session_id)
        .await
        .ok();
    let event_stream = state.agent_runs.event_stream();
    let placeholder = post_placeholder(&state, &bot_token, &message, &agent.name).await;
    let mut reply = SlackReply::new(SlackReplyParams {
        state: &state,
        pool,
        bot_token: &bot_token,
        message: &message,
        username: &agent.name,
        ts: placeholder,
        session_id: &session_id,
        baseline_seq,
    });
    enqueue_or_report(&state, pool, &message, &mut reply, &session_id, &agent).await?;
    if let Some(stream) = runtime_stream {
        return match reply.run_runtime(stream).await {
            Ok(()) => {
                if let Some(text) =
                    auto_connect_factory_child(&state, pool, &agent, &config, &message, &session_id)
                        .await?
                {
                    reply.replace_text(&text).await?;
                }
                Ok(())
            }
            Err(error) => {
                let message = format!("Agent run failed: {error}");
                if let Err(update_error) = reply.replace_text(&message).await {
                    warn!("slack failure update failed: {update_error}");
                }
                Err(error)
            }
        };
    }
    match reply.run(event_stream.rx).await {
        Ok(()) => {
            if let Some(text) =
                auto_connect_factory_child(&state, pool, &agent, &config, &message, &session_id)
                    .await?
            {
                reply.replace_text(&text).await?;
            }
            Ok(())
        }
        Err(error) => {
            let message = format!("Agent run failed: {error}");
            if let Err(update_error) = reply.replace_text(&message).await {
                warn!("slack failure update failed: {update_error}");
            }
            Err(error)
        }
    }
}

async fn auto_connect_factory_child(
    state: &AppState,
    pool: &PgPool,
    platform: &ManagedAgentRow,
    config: &SlackAgentConfig,
    message: &SlackIncomingMessage,
    session_id: &str,
) -> Result<Option<String>, GatewayError> {
    if config.app_config_token_key.is_none() {
        return Ok(None);
    }
    let Some(child) = latest_unconnected_factory_child(pool, session_id).await? else {
        return Ok(None);
    };
    let arguments = serde_json::json!({
        "agent_id": child.id,
        "team_id": message.team_id,
        "channel_id": message.channel,
        "thread_ts": message.thread_ts,
        "requested_by": message.user_id,
    });
    let connected = factory_slack_app::create_child_slack_app(
        state,
        pool,
        platform,
        child,
        config,
        &arguments,
        &message.thread_ts,
    )
    .await?;
    Ok(Some(factory_connected_text(&connected)))
}

async fn latest_unconnected_factory_child(
    pool: &PgPool,
    session_id: &str,
) -> Result<Option<ManagedAgentRow>, GatewayError> {
    sqlx::query_as::<_, ManagedAgentRow>(
        r#"
        SELECT child.*
        FROM "LiteLLM_ManagedAgentsTable" child
        JOIN "LiteLLM_ManagedAgentSessionsTable" parent ON parent.id = $1
        WHERE child.owner_id = 'slack-agent-factory'
          AND child.id <> parent.agent_id
          AND child.created_at >= parent.created_at
          AND child.config->'slack' IS NULL
        ORDER BY child.created_at DESC
        LIMIT 1
        "#,
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

fn factory_connected_text(payload: &serde_json::Value) -> String {
    let agent_name = payload
        .get("agent")
        .and_then(|agent| agent.get("name"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Agent");
    let status = payload
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("slack_app_created");
    let agent_url = payload
        .get("agent_url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let install_url = payload
        .get("install_url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    format!(
        ":white_check_mark: *{}* is ready.\n\n\
         - *Status:* `{}`\n\
         - *Platform link:* <{}|Open agent>\n\
         - *Slack install link:* <{}|Install the dedicated Slack app>\n\n\
         Open the Slack install link to add the new bot to this workspace. ",
        agent_name, status, agent_url, install_url
    )
}

async fn post_placeholder(
    state: &AppState,
    bot_token: &str,
    message: &SlackIncomingMessage,
    username: &str,
) -> Option<String> {
    match web_api::post_message_as(
        &state.http,
        &state.config.slack.api_base_url,
        bot_token,
        &message.channel,
        &message.reply_thread_ts,
        "_Thinking..._",
        Some(username),
    )
    .await
    {
        Ok(ts) => Some(ts),
        Err(error) => {
            warn!("slack placeholder failed: {error}");
            None
        }
    }
}

async fn enqueue_or_report(
    state: &Arc<AppState>,
    pool: &PgPool,
    message: &SlackIncomingMessage,
    reply: &mut SlackReply<'_>,
    session_id: &str,
    agent: &ManagedAgentRow,
) -> Result<(), GatewayError> {
    let result = enqueue_prompt_text(
        state.clone(),
        pool.clone(),
        session_id,
        message.prompt.clone(),
        agent.model.clone(),
    )
    .await;
    if let Err(error) = result {
        reply.replace_text(&error.to_string()).await?;
        return Err(error);
    }
    Ok(())
}
