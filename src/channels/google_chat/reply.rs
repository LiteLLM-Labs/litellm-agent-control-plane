use std::{sync::Arc, time::Duration};

use serde_json::Value;
use sqlx::PgPool;
use tracing::warn;

use crate::{
    channels::google_chat,
    db::managed_agents::registry::schema::ManagedAgentRow,
    errors::GatewayError,
    http::sessions::{enqueue_prompt_text, runtime_event_stream_for_session},
    proxy::state::AppState,
    sdk::agents::AgentEvent,
};

use super::{
    config::load_service_account_json,
    locks::GoogleChatPromptLock,
    reply_stream::GoogleChatReply,
    types::{GoogleChatAgentConfig, GoogleChatIncomingMessage},
    web_api,
};

const EVENT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

pub(crate) fn spawn_google_chat_prompt(
    state: Arc<AppState>,
    pool: PgPool,
    agent: ManagedAgentRow,
    config: GoogleChatAgentConfig,
    message: GoogleChatIncomingMessage,
    session_id: String,
) {
    tokio::spawn(async move {
        if let Err(error) =
            run_google_chat_prompt(state, pool, agent, config, message, session_id).await
        {
            warn!("google chat prompt failed: {error}");
        }
    });
}

async fn run_google_chat_prompt(
    state: Arc<AppState>,
    pool: PgPool,
    agent: ManagedAgentRow,
    config: GoogleChatAgentConfig,
    message: GoogleChatIncomingMessage,
    session_id: String,
) -> Result<(), GatewayError> {
    let _heartbeat = GoogleChatEventHeartbeat::spawn(
        pool.clone(),
        agent.id.clone(),
        message.message_name.clone(),
    );
    let service_account_json = match load_service_account_json(&state, &agent.id, &config).await {
        Ok(value) => value,
        Err(error) => return fail_claim(&pool, &agent, &message, error).await,
    };
    let token = match web_api::access_token(&state.http, &service_account_json).await {
        Ok(value) => value,
        Err(error) => return fail_claim(&pool, &agent, &message, error).await,
    };
    let _lock = GoogleChatPromptLock::acquire(&state.keyed_locks, &session_id).await;
    let baseline_seq = match google_chat::repository::last_message_seq(&pool, &session_id).await {
        Ok(value) => value,
        Err(error) => return fail_claim(&pool, &agent, &message, error).await,
    };
    let runtime_stream = runtime_event_stream_for_session(&state, &pool, &session_id)
        .await
        .ok();
    let event_stream = state.agent_runs.event_stream();
    let placeholder = post_placeholder(&state, &token, &message, &agent.name).await;
    let mut reply = GoogleChatReply::new(
        &state,
        &pool,
        &token,
        &message,
        &session_id,
        baseline_seq,
        placeholder,
    );
    if let Err(error) = enqueue_or_report(
        state.clone(),
        &pool,
        &message,
        &mut reply,
        &session_id,
        &agent,
    )
    .await
    {
        return fail_claim(&pool, &agent, &message, error).await;
    }
    let result = if let Some(stream) = runtime_stream {
        reply.run_runtime(stream).await
    } else {
        reply.run(event_stream.rx).await
    };
    match result {
        Ok(()) => complete_claim(&pool, &agent, &message).await,
        Err(error) => fail_claim(&pool, &agent, &message, error).await,
    }
}

async fn complete_claim(
    pool: &PgPool,
    agent: &ManagedAgentRow,
    message: &GoogleChatIncomingMessage,
) -> Result<(), GatewayError> {
    google_chat::repository::complete_event(pool, &agent.id, &message.message_name).await
}

struct GoogleChatEventHeartbeat {
    handle: tokio::task::JoinHandle<()>,
}

impl GoogleChatEventHeartbeat {
    fn spawn(pool: PgPool, agent_id: String, event_id: String) -> Self {
        let handle = tokio::spawn(async move {
            let mut heartbeat = tokio::time::interval(EVENT_HEARTBEAT_INTERVAL);
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                heartbeat.tick().await;
                if let Err(error) =
                    google_chat::repository::heartbeat_event(&pool, &agent_id, &event_id).await
                {
                    warn!("google chat event heartbeat failed: {error}");
                }
            }
        });
        Self { handle }
    }
}

impl Drop for GoogleChatEventHeartbeat {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn fail_claim(
    pool: &PgPool,
    agent: &ManagedAgentRow,
    message: &GoogleChatIncomingMessage,
    error: GatewayError,
) -> Result<(), GatewayError> {
    google_chat::repository::fail_event(pool, &agent.id, &message.message_name).await;
    Err(error)
}

async fn post_placeholder(
    state: &AppState,
    token: &str,
    message: &GoogleChatIncomingMessage,
    agent_name: &str,
) -> Option<String> {
    let text = format!("{agent_name} is thinking...");
    match web_api::create_message(
        &state.http,
        token,
        &message.space_name,
        message.thread_name.as_deref(),
        &text,
    )
    .await
    {
        Ok(name) => Some(name),
        Err(error) => {
            warn!("google chat placeholder failed: {error}");
            None
        }
    }
}

async fn enqueue_or_report(
    state: Arc<AppState>,
    pool: &PgPool,
    message: &GoogleChatIncomingMessage,
    reply: &mut GoogleChatReply<'_>,
    session_id: &str,
    agent: &ManagedAgentRow,
) -> Result<(), GatewayError> {
    let result = enqueue_prompt_text(
        state,
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

pub(super) fn event_payload(line: &str) -> Option<(String, Value)> {
    let data = line.strip_prefix("data: ")?;
    let payload: Value = serde_json::from_str(data.trim()).ok()?;
    Some((
        payload.get("type")?.as_str()?.to_owned(),
        payload.get("properties")?.clone(),
    ))
}

pub(super) fn runtime_text(event: &AgentEvent) -> Option<String> {
    event
        .data
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| event.data.get("delta").and_then(Value::as_str))
        .or_else(|| nested_str(&event.data, "delta", "text"))
        .or_else(|| nested_str(&event.data, "part", "text"))
        .map(str::to_owned)
        .or_else(|| content_text(event.data.get("content")?))
        .or_else(|| content_text(event.data.get("message")?.get("content")?))
}

pub(super) fn runtime_status(event: &AgentEvent) -> Option<&str> {
    event
        .data
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| nested_str(&event.data, "status", "type"))
}

fn content_text(value: &Value) -> Option<String> {
    let blocks = value.as_array()?;
    let text = blocks
        .iter()
        .filter_map(|block| {
            block
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| block.get("content").and_then(Value::as_str))
        })
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
}

fn nested_str<'a>(
    data: &'a serde_json::Map<String, Value>,
    parent: &str,
    field: &str,
) -> Option<&'a str> {
    data.get(parent)
        .and_then(Value::as_object)
        .and_then(|value| value.get(field))
        .and_then(Value::as_str)
}
