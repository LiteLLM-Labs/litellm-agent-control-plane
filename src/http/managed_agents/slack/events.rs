use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::Value;

use crate::{
    db::managed_agents::slack, errors::GatewayError,
    http::sessions::create_runtime_session_for_agent, proxy::state::AppState,
};

use super::{
    config::{load_agent, load_secret, signing_secret_key, slack_config},
    message::{incoming_message, session_prompt},
    replies::spawn_slack_prompt,
    signature,
    types::{SlackAgentConfig, SlackIncomingMessage},
};

pub async fn events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    body: Bytes,
) -> Result<Response, GatewayError> {
    let pool = state
        .db
        .as_ref()
        .ok_or(GatewayError::MissingDatabase)?
        .clone();
    let payload: Value = serde_json::from_slice(&body)?;
    if payload.get("type").and_then(Value::as_str) == Some("url_verification") {
        return Ok((StatusCode::OK, challenge(&payload)).into_response());
    }

    let agent = load_agent(&pool, &agent_id).await?;
    let config = slack_config(&agent)?;
    let secret = load_secret(&state, &signing_secret_key(&agent.id, &config)).await?;
    signature::verify(&headers, &body, &secret)?;

    if payload.get("type").and_then(Value::as_str) == Some("event_callback") {
        handle_event_callback(state, pool, agent, config, &payload).await?;
    }
    Ok(StatusCode::OK.into_response())
}

async fn handle_event_callback(
    state: Arc<AppState>,
    pool: sqlx::PgPool,
    agent: crate::db::managed_agents::registry::schema::ManagedAgentRow,
    config: SlackAgentConfig,
    payload: &Value,
) -> Result<(), GatewayError> {
    let Some(message) = incoming_message(payload) else {
        return Ok(());
    };
    let (agent, config) =
        super::dispatch::route_agent(&pool, agent, config, payload, &message).await?;
    let event_key = slack_event_key(payload, &message);
    if !slack::repository::record_event(&pool, &agent.id, &event_key).await? {
        return Ok(());
    }
    let (row, message) = match message.requires_existing_thread {
        true => {
            match slack::repository::get(&pool, &agent.id, &message.channel, &message.thread_ts)
                .await?
            {
                Some(row) => (row, message),
                None => return Ok(()),
            }
        }
        false => {
            let prompt = session_prompt(&message);
            let session_id = create_runtime_session_for_agent(
                state.clone(),
                &pool,
                agent.id.clone(),
                agent_runtime(&agent),
                format!("Slack {} {}", message.channel, message.thread_ts),
                prompt.clone(),
                serde_json::json!({
                    "source": "slack",
                    "channel_id": message.channel,
                    "thread_ts": message.thread_ts,
                    "team_id": message.team_id,
                    "user_id": message.user_id,
                }),
            )
            .await?;
            slack::repository::upsert(
                &pool,
                &agent.id,
                &message.channel,
                &message.thread_ts,
                &session_id,
            )
            .await
            .map(|row| (row, SlackIncomingMessage { prompt, ..message }))?
        }
    };
    spawn_slack_prompt(state, pool, agent, config, message, row.session_id);
    Ok(())
}

fn agent_runtime(agent: &crate::db::managed_agents::registry::schema::ManagedAgentRow) -> String {
    agent
        .config
        .get("runtime")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|runtime| !runtime.is_empty())
        .unwrap_or(crate::sdk::agents::CLAUDE_MANAGED_AGENTS)
        .to_owned()
}

fn challenge(payload: &Value) -> String {
    payload
        .get("challenge")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn slack_event_key(payload: &Value, message: &SlackIncomingMessage) -> String {
    payload
        .get("event_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| fallback_event_key(payload, message))
}

fn fallback_event_key(payload: &Value, message: &SlackIncomingMessage) -> String {
    let event = payload.get("event").unwrap_or(&Value::Null);
    let ts = event
        .get("event_ts")
        .or_else(|| event.get("ts"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let user = event
        .get("user")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let text = event
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    format!(
        "fallback:{}:{}:{}:{}:{}",
        message.channel, message.thread_ts, ts, user, text
    )
}
