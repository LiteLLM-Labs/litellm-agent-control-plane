use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::json;

use crate::{
    agents::events,
    db::managed_agents::{messages, sessions},
    errors::GatewayError,
    proxy::state::AppState,
};

mod execution;
mod runtime;
mod runtime_events_api;
mod runtime_inputs;
mod runtime_lifecycle;
mod runtime_mcp_validation;
mod runtime_provision;
mod runtime_sdk;
mod storage;
mod types;

use execution::execute_prompt;
pub(crate) use runtime::create_runtime_session_for_agent;
use runtime::{create_runtime_session, execute_runtime_prompt};
pub(crate) use runtime_events_api::runtime_event_stream_for_session;
pub use runtime_events_api::{runtime_event_list, runtime_events};
use runtime_sdk::{register_runtime_session, runtime_sdk_client};
use storage::{db, persist_message, resolve_session_request, session};
pub use types::{CreateSessionRequest, MessageResponse, PromptRequest, SessionResponse};

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<SessionResponse>>, GatewayError> {
    let pool = db(&state, &headers)?;
    let rows = sessions::repository::list(pool).await?;
    Ok(Json(rows.into_iter().map(SessionResponse::from).collect()))
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateSessionRequest>,
) -> Result<Json<SessionResponse>, GatewayError> {
    let pool = db(&state, &headers)?.clone();
    if input.has_runtime() {
        return create_runtime_session(state, &pool, input).await.map(Json);
    }
    let resolved = resolve_session_request(&state, &pool, input).await?;
    let row = sessions::repository::create(
        &pool,
        &resolved.harness,
        resolved.agent_id.as_deref(),
        &resolved.title,
        resolved.timezone.as_deref(),
    )
    .await?;
    state.agent_runs.track_run(&resolved.harness, &row.id);
    Ok(Json(SessionResponse::from(row)))
}

pub async fn get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<SessionResponse>, GatewayError> {
    let pool = db(&state, &headers)?;
    let row = session(pool, &session_id).await?;
    Ok(Json(SessionResponse::from(row)))
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<bool>, GatewayError> {
    let pool = db(&state, &headers)?;
    Ok(Json(sessions::repository::delete(pool, &session_id).await?))
}

pub async fn messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Vec<MessageResponse>>, GatewayError> {
    let pool = db(&state, &headers)?;
    let rows = messages::repository::list(pool, &session_id).await?;
    rows.into_iter()
        .map(MessageResponse::try_from)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

pub async fn prompt_async(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<PromptRequest>,
) -> Result<StatusCode, GatewayError> {
    let pool = db(&state, &headers)?.clone();
    let prompt = input.prompt_text()?;
    let model = input.model_id().unwrap_or("claude-sonnet-4-6").to_owned();
    enqueue_prompt_text(state, pool, &session_id, prompt, model).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn enqueue_prompt_text(
    state: Arc<AppState>,
    pool: sqlx::PgPool,
    session_id: &str,
    prompt: String,
    model: String,
) -> Result<(), GatewayError> {
    let session_id = session_id.to_owned();
    let row = session(&pool, &session_id).await?;

    persist_message(&pool, &session_id, "user", &prompt, None).await?;
    state
        .agent_runs
        .track_run(row.agent_id.as_deref().unwrap_or(&row.harness), &session_id);

    if row.runtime.is_some() {
        execute_runtime_prompt(state, &pool, row, prompt).await?;
        return Ok(());
    }

    tokio::spawn(async move {
        if let Err(error) = execute_prompt(state.clone(), pool, row, prompt, model).await {
            record_prompt_error(&state, &session_id, error);
        }
    });

    Ok(())
}

pub async fn send_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<PromptRequest>,
) -> Result<Json<Vec<MessageResponse>>, GatewayError> {
    prompt_async(
        State(state.clone()),
        headers.clone(),
        Path(session_id.clone()),
        Json(input),
    )
    .await?;
    let pool = db(&state, &headers)?;
    let rows = messages::repository::list(pool, &session_id).await?;
    rows.into_iter()
        .map(MessageResponse::try_from)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

pub async fn abort(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<StatusCode, GatewayError> {
    let pool = db(&state, &headers)?;
    if let Ok(Some(row)) = sessions::repository::get(pool, &session_id).await {
        if let Some(runtime) = row.runtime.as_deref() {
            if let Ok(resolved) =
                crate::http::runtime_resolution::resolve_runtime(pool, &state, runtime).await
            {
                if let Ok(client) = runtime_sdk_client(&resolved) {
                    if register_runtime_session(&client, pool, &row, &resolved)
                        .await
                        .is_ok()
                    {
                        let _ = client
                            .beta()
                            .sessions()
                            .events()
                            .interrupt(&session_id)
                            .await;
                    }
                }
            }
        }
    }
    state
        .agent_runs
        .set_error(&session_id, "aborted".to_owned());
    state.agent_runs.push_event(
        &session_id,
        events::SESSION_ERROR,
        json!({ "error": { "name": "MessageAbortedError", "message": "aborted" } }),
    );
    state
        .agent_runs
        .push_event(&session_id, events::SESSION_IDLE, json!({}));
    Ok(StatusCode::NO_CONTENT)
}

pub async fn interrupt(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<StatusCode, GatewayError> {
    let pool = db(&state, &headers)?;
    let Ok(Some(row)) = sessions::repository::get(pool, &session_id).await else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let Some(runtime) = row.runtime.as_deref() else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let Ok(resolved) =
        crate::http::runtime_resolution::resolve_runtime(pool, &state, runtime).await
    else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let Ok(client) = runtime_sdk_client(&resolved) else {
        return Ok(StatusCode::NO_CONTENT);
    };
    if register_runtime_session(&client, pool, &row, &resolved)
        .await
        .is_ok()
    {
        let _ = client
            .beta()
            .sessions()
            .events()
            .interrupt(&session_id)
            .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

fn record_prompt_error(state: &AppState, session_id: &str, error: GatewayError) {
    let message = error.to_string();
    state.agent_runs.set_error(session_id, message.clone());
    state.agent_runs.push_event(
        session_id,
        events::SESSION_ERROR,
        json!({ "error": { "message": message } }),
    );
    state
        .agent_runs
        .push_event(session_id, events::SESSION_IDLE, json!({}));
}
