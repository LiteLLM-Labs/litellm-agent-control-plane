use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::{json, Value};

use crate::{
    db::managed_agents::{
        google_chat::{self, repository::EventClaim},
        registry::schema::ManagedAgentRow,
    },
    errors::GatewayError,
    http::sessions::create_runtime_session_for_agent_without_prompt,
    proxy::state::AppState,
    sdk::agents::CLAUDE_MANAGED_AGENTS,
};

use super::{
    auth,
    config::{google_chat_config, load_agent},
    event_message::{can_start_session, incoming_message_for_app},
    reply::spawn_google_chat_prompt,
    session_lock::GoogleChatConversationLock,
    types::{GoogleChatEvent, GoogleChatIncomingMessage},
};

pub(crate) async fn events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Json(event): Json<GoogleChatEvent>,
) -> Result<StatusCode, GatewayError> {
    let pool = state
        .db
        .as_ref()
        .ok_or(GatewayError::MissingDatabase)?
        .clone();
    let agent = load_agent(&pool, &agent_id).await?;
    let config = google_chat_config(&agent)?;
    let endpoint_audience = config_value(config.auth_audience.as_deref());
    let project_number = config_value(config.project_number.as_deref());
    if endpoint_audience.is_none() && project_number.is_none() {
        return Err(GatewayError::InvalidConfig(
            "google_chat auth_audience or project_number is not configured".to_owned(),
        ));
    }
    auth::verify_google_chat_request(
        &state.http,
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
        endpoint_audience,
        project_number,
    )
    .await?;
    let message = match incoming_message_for_app(event, config.app_name.as_deref()) {
        Some(message) => message,
        None => return Ok(StatusCode::OK),
    };
    let _conversation_lock = GoogleChatConversationLock::acquire(
        &state.keyed_locks,
        &agent.id,
        &message.conversation_key,
    )
    .await;
    let Some(session_id) = ensure_session(state.clone(), &pool, &agent, &message).await? else {
        return Ok(StatusCode::OK);
    };
    match google_chat::repository::claim_event(&pool, &agent.id, &message.message_name).await? {
        EventClaim::Claimed => {}
        EventClaim::Completed => return Ok(StatusCode::OK),
        EventClaim::InProgress => return Ok(StatusCode::SERVICE_UNAVAILABLE),
    }
    spawn_google_chat_prompt(state, pool, agent, config, message, session_id);
    Ok(StatusCode::ACCEPTED)
}

async fn ensure_session(
    state: Arc<AppState>,
    pool: &sqlx::PgPool,
    agent: &ManagedAgentRow,
    message: &GoogleChatIncomingMessage,
) -> Result<Option<String>, GatewayError> {
    if let Some(session_id) = refresh_existing_session(pool, agent, message).await? {
        return Ok(Some(session_id));
    }
    if !can_start_session(message) {
        return Ok(None);
    }
    let session_id = create_session(state, pool, agent, message).await?;
    upsert_session(pool, agent, message, &session_id)
        .await
        .map(Some)
}

async fn refresh_existing_session(
    pool: &sqlx::PgPool,
    agent: &ManagedAgentRow,
    message: &GoogleChatIncomingMessage,
) -> Result<Option<String>, GatewayError> {
    let Some(row) =
        google_chat::repository::get(pool, &agent.id, &message.conversation_key).await?
    else {
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
    message: &GoogleChatIncomingMessage,
) -> Result<String, GatewayError> {
    create_runtime_session_for_agent_without_prompt(
        state,
        pool,
        agent.id.clone(),
        agent_runtime(agent),
        format!("Google Chat {}", message.space_name),
        session_metadata(message),
    )
    .await
}

async fn upsert_session(
    pool: &sqlx::PgPool,
    agent: &ManagedAgentRow,
    message: &GoogleChatIncomingMessage,
    session_id: &str,
) -> Result<String, GatewayError> {
    let row = google_chat::repository::upsert(
        pool,
        google_chat::repository::UpsertSessionInput {
            agent_id: &agent.id,
            conversation_key: &message.conversation_key,
            session_id,
            space_name: &message.space_name,
            thread_name: message.thread_name.as_deref(),
        },
    )
    .await?;
    Ok(row.session_id)
}

fn session_metadata(message: &GoogleChatIncomingMessage) -> Value {
    json!({
        "source": "google_chat",
        "space_name": message.space_name,
        "thread_name": message.thread_name,
        "conversation_key": message.conversation_key,
        "user_name": message.user_name,
        "mode": message.mode.as_str(),
    })
}

fn config_value(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
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
