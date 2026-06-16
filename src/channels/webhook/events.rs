use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::{json, Value};
use tracing::warn;

use crate::{
    db::managed_agents::registry::schema::ManagedAgentRow,
    errors::GatewayError,
    http::sessions::{create_runtime_session_for_agent_without_prompt, enqueue_prompt_text},
    proxy::state::AppState,
};

use super::{
    config::{agent_runtime, load_agent, load_webhook_secret, webhook_config},
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
    let prompt = webhook_prompt(&payload)?;
    let session_id = create_runtime_session_for_agent_without_prompt(
        state.clone(),
        &pool,
        agent.id.clone(),
        agent_runtime(&agent),
        session_title(&request_id),
        session_metadata(&headers, &request_id),
    )
    .await?;
    spawn_webhook_prompt(state, pool, agent, session_id.clone(), prompt);

    Ok((
        StatusCode::ACCEPTED,
        Json(WebhookAcceptedResponse {
            status: "accepted",
            agent_id,
            session_id,
            request_id,
        }),
    ))
}

fn spawn_webhook_prompt(
    state: Arc<AppState>,
    pool: sqlx::PgPool,
    agent: ManagedAgentRow,
    session_id: String,
    prompt: String,
) {
    tokio::spawn(async move {
        if let Err(error) =
            enqueue_prompt_text(state, pool, &session_id, prompt, agent.model.clone()).await
        {
            warn!("webhook prompt failed: {error}");
        }
    });
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
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0_u8, |acc, (left, right)| acc | (left ^ right))
        == 0
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
            "x-request-id",
            "x-zendesk-webhook-id",
            "x-zendesk-event-id",
            "x-github-delivery",
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
mod tests {
    use axum::http::{HeaderMap, HeaderValue};
    use serde_json::json;

    use super::{
        authorization_token, constant_time_eq, request_id, session_title, truncate_title,
        verify_webhook_secret, webhook_prompt,
    };

    #[test]
    fn verify_webhook_secret_accepts_authorization_bearer() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer secret-123"),
        );

        assert!(verify_webhook_secret(&headers, "secret-123").is_ok());
        assert_eq!(authorization_token("bearer abc"), "abc");
    }

    #[test]
    fn webhook_prompt_sends_full_pretty_json_payload() {
        let prompt = webhook_prompt(
            &json!({ "ticket": { "id": "ZD-99", "description": "Customer cannot log in" } }),
        )
        .unwrap();

        assert!(prompt.contains("\"id\": \"ZD-99\""));
        assert!(prompt.contains("\"description\": \"Customer cannot log in\""));
    }

    #[test]
    fn session_title_uses_request_id() {
        assert_eq!(session_title("zd-check-99"), "Webhook zd-check-99");
    }

    #[test]
    fn request_id_prefers_known_delivery_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("x-zendesk-webhook-id", HeaderValue::from_static("zd-123"));

        assert_eq!(request_id(&headers), "zd-123");
    }

    #[test]
    fn constant_time_eq_matches_equal_strings() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }

    #[test]
    fn truncate_title_handles_multibyte_characters() {
        let title = truncate_title(&format!("Webhook {}", "\u{00e9}".repeat(130)));

        assert!(title.ends_with("..."));
        assert!(title.is_char_boundary(title.len() - 3));
    }
}
