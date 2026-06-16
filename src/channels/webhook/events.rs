use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::{json, Value};
use tracing::warn;

use crate::{
    db::managed_agents::{registry::schema::ManagedAgentRow, sessions},
    errors::GatewayError,
    http::sessions::{create_runtime_session_for_agent_without_prompt, enqueue_prompt_text},
    proxy::state::AppState,
};

use super::{
    config::{agent_runtime, load_agent, load_webhook_secret, webhook_config},
    repository::{self, EventRecord},
    types::WebhookAcceptedResponse,
};

pub(crate) async fn events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Json(payload): Json<Value>,
) -> Result<(StatusCode, Json<WebhookAcceptedResponse>), GatewayError> {
    let pool = state
        .db
        .as_ref()
        .ok_or(GatewayError::MissingDatabase)?
        .clone();
    let agent = load_agent(&pool, &agent_id).await?;
    let config = webhook_config(&agent)?;
    let secret = load_webhook_secret(&state, &agent.id, &config).await?;
    verify_webhook_secret(&headers, &secret)?;

    let request_id = request_id(&headers);
    if let Some(response) = event_response(&pool, &agent.id, &agent_id, &request_id).await? {
        return Ok(response);
    }
    let prompt = webhook_prompt(&payload)?;
    let session_id = create_session(state.clone(), &pool, &agent, &headers, &request_id).await?;
    if !repository::record_event(&pool, &agent.id, &request_id, &session_id).await? {
        cleanup_created_session(&pool, &session_id).await;
        let response = event_response(&pool, &agent.id, &agent_id, &request_id)
            .await?
            .unwrap_or(webhook_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "processing",
                agent_id.clone(),
                String::new(),
                request_id.clone(),
            )?);
        return Ok(response);
    }
    if let Err(error) = send_webhook_prompt(state, pool.clone(), &agent, &session_id, prompt).await
    {
        cleanup_event_session(&pool, &agent.id, &request_id, &session_id).await;
        return Err(error);
    }
    repository::complete_event(&pool, &agent.id, &request_id).await?;

    webhook_response(
        StatusCode::ACCEPTED,
        "accepted",
        agent_id,
        session_id,
        request_id,
    )
}

async fn event_response(
    pool: &sqlx::PgPool,
    agent_id: &str,
    response_agent_id: &str,
    request_id: &str,
) -> Result<Option<(StatusCode, Json<WebhookAcceptedResponse>)>, GatewayError> {
    let response = match repository::get_event(pool, agent_id, request_id).await? {
        None => return Ok(None),
        Some(EventRecord::Completed { session_id }) => webhook_response(
            StatusCode::ACCEPTED,
            "duplicate",
            response_agent_id.to_owned(),
            session_id,
            request_id.to_owned(),
        )?,
        Some(EventRecord::Processing) => webhook_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "processing",
            response_agent_id.to_owned(),
            String::new(),
            request_id.to_owned(),
        )?,
    };
    Ok(Some(response))
}

async fn send_webhook_prompt(
    state: Arc<AppState>,
    pool: sqlx::PgPool,
    agent: &ManagedAgentRow,
    session_id: &str,
    prompt: String,
) -> Result<(), GatewayError> {
    enqueue_prompt_text(state, pool, session_id, prompt, agent.model.clone()).await
}

async fn create_session(
    state: Arc<AppState>,
    pool: &sqlx::PgPool,
    agent: &ManagedAgentRow,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<String, GatewayError> {
    match create_runtime_session_for_agent_without_prompt(
        state,
        pool,
        agent.id.clone(),
        agent_runtime(agent),
        session_title(request_id),
        session_metadata(headers, request_id),
    )
    .await
    {
        Ok(session_id) => Ok(session_id),
        Err(error) => {
            let _ = repository::delete_event(pool, &agent.id, request_id).await;
            Err(error)
        }
    }
}

fn webhook_response(
    status_code: StatusCode,
    status: &'static str,
    agent_id: String,
    session_id: String,
    request_id: String,
) -> Result<(StatusCode, Json<WebhookAcceptedResponse>), GatewayError> {
    Ok((
        status_code,
        Json(WebhookAcceptedResponse {
            status,
            agent_id,
            session_id,
            request_id,
        }),
    ))
}

async fn cleanup_event_session(
    pool: &sqlx::PgPool,
    agent_id: &str,
    request_id: &str,
    session_id: &str,
) {
    let _ = repository::delete_event(pool, agent_id, request_id).await;
    cleanup_created_session(pool, session_id).await;
}

async fn cleanup_created_session(pool: &sqlx::PgPool, session_id: &str) {
    if let Err(error) = sessions::repository::delete(pool, session_id).await {
        warn!("webhook session cleanup failed: {error}");
    }
}

fn verify_webhook_secret(headers: &HeaderMap, secret: &str) -> Result<(), GatewayError> {
    let secret = secret.trim();
    if secret.is_empty() {
        return Err(GatewayError::InvalidConfig(
            "webhook secret is empty".to_owned(),
        ));
    }
    if authorization_matches_secret(headers, secret) {
        return Ok(());
    }
    Err(GatewayError::Unauthorized)
}

fn authorization_matches_secret(headers: &HeaderMap, secret: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(authorization_token)
        .is_some_and(|value| constant_time_eq(value, secret))
}

fn authorization_token(value: &str) -> &str {
    let value = value.trim();
    if value.len() >= 7 && value[..7].eq_ignore_ascii_case("bearer ") {
        return value[7..].trim();
    }
    value
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    const MAX_WEBHOOK_SECRET_BYTES: usize = 4096;

    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut diff = left.len() ^ right.len();
    if left.len() > MAX_WEBHOOK_SECRET_BYTES || right.len() > MAX_WEBHOOK_SECRET_BYTES {
        diff |= 1;
    }
    for index in 0..MAX_WEBHOOK_SECRET_BYTES {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        diff |= usize::from(left_byte ^ right_byte);
    }
    diff == 0
}

fn webhook_prompt(payload: &Value) -> Result<String, GatewayError> {
    Ok(serde_json::to_string_pretty(payload)?)
}

fn session_title(request_id: &str) -> String {
    truncate_title(&format!("Webhook {request_id}"))
}

fn truncate_title(value: &str) -> String {
    const MAX_TITLE_LEN: usize = 120;
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_TITLE_LEN {
        return trimmed.to_owned();
    }
    let truncated = trimmed.chars().take(MAX_TITLE_LEN - 3).collect::<String>();
    format!("{truncated}...")
}

fn session_metadata(headers: &HeaderMap, request_id: &str) -> Value {
    json!({
        "source": "webhook",
        "request_id": request_id,
        "content_type": header_value(headers, "content-type"),
        "user_agent": header_value(headers, "user-agent"),
        "webhook_event_id": first_header_value(headers, &[
            "x-zendesk-webhook-id",
            "x-zendesk-event-id",
            "x-github-delivery",
        ]),
    })
}

fn request_id(headers: &HeaderMap) -> String {
    first_header_value(
        headers,
        &[
            "x-zendesk-webhook-id",
            "x-zendesk-event-id",
            "x-github-delivery",
            "x-request-id",
        ],
    )
    .unwrap_or_else(|| format!("webhook_{}", uuid::Uuid::new_v4().simple()))
}

fn first_header_value(headers: &HeaderMap, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| header_value(headers, name))
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(non_empty)
        .map(str::to_owned)
}

fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;
