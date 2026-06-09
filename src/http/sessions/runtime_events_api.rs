use std::{collections::HashMap, convert::Infallible, sync::Arc};

use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::HeaderMap,
    response::Response,
    Json,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    callbacks::events::CallbackEventPayload,
    db::managed_agents::runtime_events,
    errors::GatewayError,
    proxy::{auth::master_key::require_master_key, state::AppState},
    sdk::agents::{AgentEvent, AgentEventStream},
};

use super::{
    runtime_lifecycle::{
        event_error_message, mark_session_status, persist_runtime_event, terminal_event_status,
    },
    runtime_sdk::{
        agent_sdk_error, provider_event_line, register_runtime_session, runtime_sdk_client,
    },
    storage::session,
};

pub async fn runtime_events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Response, GatewayError> {
    require_events_master_key(
        &headers,
        &query,
        state.config.general_settings.master_key.as_deref(),
    )?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let row = session(pool, &session_id).await?;
    let runtime = row.runtime.as_deref().ok_or_else(|| {
        GatewayError::InvalidConfig("session is not a runtime session".to_owned())
    })?;
    let resolved = crate::http::runtime_resolution::resolve_runtime(pool, &state, runtime).await?;
    let client = runtime_sdk_client(&resolved)?;
    register_runtime_session(&client, pool, &row, &resolved).await?;
    let provider_stream = client
        .beta()
        .sessions()
        .events()
        .stream(&row.id)
        .await
        .map_err(agent_sdk_error)?;
    let empty_stream_status =
        (row.provider_run_id.is_none() && row.status == "idle").then_some("idle");
    let stream_pool = pool.clone();
    let stream_session_id = row.id.clone();
    let body_stream = provider_body_stream(
        provider_stream,
        stream_pool,
        stream_session_id,
        state.clone(),
        empty_stream_status,
    );
    Response::builder()
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(body_stream))
        .map_err(|error| GatewayError::SandboxError(error.to_string()))
}

fn provider_body_stream(
    provider_stream: AgentEventStream,
    stream_pool: PgPool,
    stream_session_id: String,
    stream_state: Arc<AppState>,
    empty_stream_status: Option<&'static str>,
) -> impl futures_util::Stream<Item = Result<Bytes, Infallible>> {
    let callbacks = stream_state.callbacks.clone();
    async_stream::stream! {
        futures_util::pin_mut!(provider_stream);
        let mut saw_event = false;
        let mut terminal_status = None;
        let mut terminal_error = None;
        while let Some(event) = provider_stream.next().await {
            match event {
                Ok(event) => {
                    saw_event = true;
                    if let Some(status) = terminal_event_status(&event) {
                        terminal_status = Some(status);
                        if status == "error" {
                            terminal_error = Some(event_error_message(&event));
                        }
                    }
                    let _ = persist_runtime_event(&stream_pool, &stream_session_id, &event).await;
                    emit_runtime_event(&callbacks, &stream_session_id, &event).await;
                    yield provider_event_line(Ok(event));
                }
                Err(error) => {
                    terminal_status = Some("error");
                    terminal_error = Some(error.to_string());
                    yield provider_event_line::<AgentEvent>(Err(error));
                }
            }
        }
        if !saw_event && terminal_status.is_none() {
            terminal_status = empty_stream_status;
        }
        if let Some(status) = terminal_status {
            let _ = mark_session_status(
                &stream_state,
                &stream_pool,
                &stream_session_id,
                status,
                terminal_error,
            ).await;
        }
    }
}

pub async fn runtime_event_list(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, GatewayError> {
    require_events_master_key(
        &headers,
        &query,
        state.config.general_settings.master_key.as_deref(),
    )?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let row = session(pool, &session_id).await?;
    let stored = runtime_events::repository::list(pool, &row.id).await?;
    if !stored.is_empty() {
        return Ok(Json(json!({ "data": stored })));
    }
    let runtime = row.runtime.as_deref().ok_or_else(|| {
        GatewayError::InvalidConfig("session is not a runtime session".to_owned())
    })?;
    let resolved = crate::http::runtime_resolution::resolve_runtime(pool, &state, runtime).await?;
    let client = runtime_sdk_client(&resolved)?;
    register_runtime_session(&client, pool, &row, &resolved).await?;
    let events = client
        .beta()
        .sessions()
        .events()
        .list(&row.id)
        .await
        .map_err(agent_sdk_error)?;
    emit_runtime_event_list(&state.callbacks, &row.id, &events).await;
    Ok(Json(events))
}

pub(crate) async fn runtime_event_stream_for_session(
    state: &AppState,
    pool: &PgPool,
    session_id: &str,
) -> Result<AgentEventStream, GatewayError> {
    let row = session(pool, session_id).await?;
    let runtime = row.runtime.as_deref().ok_or_else(|| {
        GatewayError::InvalidConfig("session is not a runtime session".to_owned())
    })?;
    let resolved = crate::http::runtime_resolution::resolve_runtime(pool, state, runtime).await?;
    let client = runtime_sdk_client(&resolved)?;
    register_runtime_session(&client, pool, &row, &resolved).await?;
    client
        .beta()
        .sessions()
        .events()
        .stream(&row.id)
        .await
        .map_err(agent_sdk_error)
}

fn require_events_master_key(
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    configured: Option<&str>,
) -> Result<(), GatewayError> {
    if query.get("key").map(String::as_str) == configured {
        return Ok(());
    }
    require_master_key(headers, configured)
}

async fn emit_runtime_event<T: serde::Serialize>(
    callbacks: &crate::callbacks::CallbackManager,
    session_id: &str,
    event: &T,
) {
    if let Some(payload) = CallbackEventPayload::managed_runtime_session_event(session_id, event) {
        callbacks.on_event(payload).await;
    }
}

async fn emit_runtime_event_list(
    callbacks: &crate::callbacks::CallbackManager,
    session_id: &str,
    events: &Value,
) {
    let items = events
        .as_array()
        .or_else(|| events.get("data").and_then(Value::as_array));
    if let Some(items) = items {
        for event in items {
            emit_runtime_event(callbacks, session_id, event).await;
        }
    }
}
