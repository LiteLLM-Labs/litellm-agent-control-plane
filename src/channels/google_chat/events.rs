use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::{json, Value};
use tracing::warn;

use crate::{
    channels::google_chat::{self, repository::EventClaim},
    db::managed_agents::{registry::schema::ManagedAgentRow, sessions},
    errors::GatewayError,
    http::sessions::create_runtime_session_for_agent_without_prompt,
    proxy::state::AppState,
    sdk::agents::CLAUDE_MANAGED_AGENTS,
};

use super::{
    auth,
    config::{google_chat_config, load_agent},
    event_message::{can_start_session, incoming_message_for_app},
    locks::GoogleChatConversationLock,
    reply::spawn_google_chat_prompt,
    types::{GoogleChatEvent, GoogleChatIncomingMessage, GoogleChatMessageMode},
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
    let endpoint_audience = config_value(config.auth_audience.as_deref()).ok_or_else(|| {
        GatewayError::InvalidConfig("google_chat auth_audience is not configured".to_owned())
    })?;
    auth::verify_google_chat_request(
        &state.http,
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
        endpoint_audience,
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
    match upsert_session(pool, agent, message, &session_id).await {
        Ok(mapped_session_id) => {
            if mapped_session_id != session_id {
                cleanup_created_session(pool, &session_id).await;
            }
            Ok(Some(mapped_session_id))
        }
        Err(error) => {
            cleanup_created_session(pool, &session_id).await;
            Err(error)
        }
    }
}

async fn refresh_existing_session(
    pool: &sqlx::PgPool,
    agent: &ManagedAgentRow,
    message: &GoogleChatIncomingMessage,
) -> Result<Option<String>, GatewayError> {
    let row = match google_chat::repository::get(pool, &agent.id, &message.conversation_key).await?
    {
        Some(row) => row,
        None => match space_session_fallback_key(message) {
            Some(key) => match google_chat::repository::get(pool, &agent.id, key).await? {
                Some(row) => row,
                None => return Ok(None),
            },
            None => return Ok(None),
        },
    };
    Ok(Some(
        upsert_session(pool, agent, message, &row.session_id).await?,
    ))
}

fn space_session_fallback_key(message: &GoogleChatIncomingMessage) -> Option<&str> {
    if !matches!(message.mode, GoogleChatMessageMode::ChannelMessage) {
        return None;
    }
    if message.thread_name.is_none() || message.conversation_key == message.space_name {
        return None;
    }
    Some(message.space_name.as_str())
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

async fn cleanup_created_session(pool: &sqlx::PgPool, session_id: &str) {
    if let Err(error) = sessions::repository::delete(pool, session_id).await {
        warn!("google chat session cleanup failed: {error}");
    }
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

#[cfg(test)]
mod session_tests {
    use super::space_session_fallback_key;
    use crate::channels::google_chat::types::{GoogleChatIncomingMessage, GoogleChatMessageMode};

    #[test]
    fn threaded_channel_messages_can_fallback_to_space_session() {
        let message = incoming(GoogleChatMessageMode::ChannelMessage);

        assert_eq!(space_session_fallback_key(&message), Some("spaces/AAA"));
    }

    #[test]
    fn fallback_skips_direct_messages_mentions_and_unthreaded_messages() {
        assert_eq!(
            space_session_fallback_key(&incoming(GoogleChatMessageMode::DirectMessage)),
            None
        );
        assert_eq!(
            space_session_fallback_key(&incoming(GoogleChatMessageMode::ChannelMention)),
            None
        );

        let mut message = incoming(GoogleChatMessageMode::ChannelMessage);
        message.thread_name = None;
        message.conversation_key = message.space_name.clone();

        assert_eq!(space_session_fallback_key(&message), None);
    }

    fn incoming(mode: GoogleChatMessageMode) -> GoogleChatIncomingMessage {
        GoogleChatIncomingMessage {
            message_name: "spaces/AAA/messages/msg-xyz".to_owned(),
            space_name: "spaces/AAA".to_owned(),
            thread_name: Some("spaces/AAA/threads/thread-1".to_owned()),
            conversation_key: "spaces/AAA/threads/thread-1".to_owned(),
            user_name: Some("users/human-1".to_owned()),
            prompt: "hello".to_owned(),
            mode,
        }
    }
}
