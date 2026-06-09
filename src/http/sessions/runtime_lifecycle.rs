use futures_util::StreamExt;
use serde_json::Value;
use sqlx::PgPool;

use crate::{
    agents::runs::AgentRunStatus,
    db::managed_agents::{runtime_events, sessions},
    errors::GatewayError,
    proxy::state::AppState,
    sdk::agents::{AgentEvent, AgentEventStream},
};

use super::runtime_sdk::agent_sdk_error;

pub(super) async fn mark_session_idle(
    state: &AppState,
    pool: &PgPool,
    session_id: &str,
) -> Result<(), GatewayError> {
    mark_session_status(state, pool, session_id, "idle", None).await
}

pub(super) async fn mark_session_error(
    state: &AppState,
    pool: &PgPool,
    session_id: &str,
    message: String,
) -> Result<(), GatewayError> {
    mark_session_status(state, pool, session_id, "error", Some(message)).await
}

pub(super) async fn mark_session_status(
    state: &AppState,
    pool: &PgPool,
    session_id: &str,
    status: &str,
    error: Option<String>,
) -> Result<(), GatewayError> {
    sessions::repository::set_status(pool, session_id, status).await?;
    match status {
        "idle" => state
            .agent_runs
            .update_status(session_id, AgentRunStatus::Completed),
        "error" => state.agent_runs.set_error(
            session_id,
            error.unwrap_or_else(|| "managed agent interaction failed".to_owned()),
        ),
        _ => {}
    }
    Ok(())
}

pub(super) async fn persist_send_response_events(
    pool: &PgPool,
    resolved: &crate::http::runtime_resolution::ResolvedRuntime,
    session_id: &str,
    raw: &Value,
) -> Result<(), GatewayError> {
    for event in resolved.adapter.events_from_send_response_raw(raw) {
        runtime_events::repository::append(pool, session_id, event).await?;
    }
    Ok(())
}

pub(super) async fn drain_provider_stream(
    state: &AppState,
    pool: &PgPool,
    session_id: &str,
    provider_stream: AgentEventStream,
) -> Result<(), GatewayError> {
    futures_util::pin_mut!(provider_stream);
    let mut terminal_status = None;
    let mut terminal_error = None;
    while let Some(event) = provider_stream.next().await {
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                let error = agent_sdk_error(error);
                mark_session_error(state, pool, session_id, error.to_string()).await?;
                return Err(error);
            }
        };
        if let Some(status) = terminal_event_status(&event) {
            terminal_status = Some(status);
            if status == "error" {
                terminal_error = Some(event_error_message(&event));
            }
        }
        persist_runtime_event(pool, session_id, &event).await?;
    }
    let status = terminal_status.unwrap_or("idle");
    mark_session_status(state, pool, session_id, status, terminal_error).await?;
    Ok(())
}

pub(super) async fn persist_runtime_event(
    pool: &PgPool,
    session_id: &str,
    event: &AgentEvent,
) -> Result<(), GatewayError> {
    let event_json = serde_json::to_value(event)
        .map_err(|error| GatewayError::SandboxError(error.to_string()))?;
    runtime_events::repository::append(pool, session_id, event_json).await?;
    Ok(())
}

pub(super) fn update_agent_run_status(
    state: &AppState,
    session_id: &str,
    status: &str,
    raw: &Value,
) {
    match status {
        "idle" => state
            .agent_runs
            .update_status(session_id, AgentRunStatus::Completed),
        "error" => state
            .agent_runs
            .set_error(session_id, provider_error_message(raw)),
        _ => {}
    }
}

pub(super) fn provider_run_status(raw: &Value) -> &'static str {
    match raw.get("status").and_then(Value::as_str) {
        Some("completed") => "idle",
        Some("failed" | "cancelled" | "incomplete" | "budget_exceeded") => "error",
        _ => "running",
    }
}

pub(super) fn terminal_event_status(event: &AgentEvent) -> Option<&'static str> {
    match event.event_type.as_str() {
        "session.status_idle" => Some("idle"),
        "session.error" => Some("error"),
        _ => None,
    }
}

pub(super) fn event_error_message(event: &AgentEvent) -> String {
    event
        .data
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .unwrap_or("managed agent interaction failed")
        .to_owned()
}

fn provider_error_message(raw: &Value) -> String {
    raw.get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .unwrap_or("managed agent interaction failed")
        .to_owned()
}
