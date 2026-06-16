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
    config::{
        agent_runtime, configured_header_name, load_agent, load_webhook_secret, webhook_config,
    },
    types::{WebhookAcceptedResponse, WebhookAgentConfig},
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
    verify_webhook_secret(&headers, &config, &secret)?;

    let request_id = request_id(&headers);
    let prompt = webhook_prompt(&payload, &config)?;
    let session_id = create_runtime_session_for_agent_without_prompt(
        state.clone(),
        &pool,
        agent.id.clone(),
        agent_runtime(&agent),
        session_title(&agent, &payload, &config),
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

fn verify_webhook_secret(
    headers: &HeaderMap,
    config: &WebhookAgentConfig,
    secret: &str,
) -> Result<(), GatewayError> {
    let secret = secret.trim();
    if secret.is_empty() {
        return Err(GatewayError::InvalidConfig(
            "webhook secret is empty".to_owned(),
        ));
    }
    let configured = configured_header_name(config);
    if header_matches_secret(headers, configured, secret)
        || authorization_matches_secret(headers, secret)
    {
        return Ok(());
    }
    Err(GatewayError::Unauthorized)
}

fn header_matches_secret(headers: &HeaderMap, name: &str, secret: &str) -> bool {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .is_some_and(|value| constant_time_eq(value, secret))
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

fn webhook_prompt(payload: &Value, config: &WebhookAgentConfig) -> Result<String, GatewayError> {
    if let Some(pointer) = config_pointer(config.prompt_json_pointer.as_deref()) {
        let value = payload.pointer(pointer).ok_or_else(|| {
            GatewayError::InvalidJsonMessage(format!(
                "webhook prompt_json_pointer did not match payload: {pointer}"
            ))
        })?;
        return prompt_from_value(
            value,
            "webhook prompt_json_pointer resolved to an empty value",
        );
    }
    for key in ["prompt", "message", "text", "input"] {
        if let Some(value) = payload.get(key) {
            if let Ok(prompt) = prompt_from_value(value, "") {
                return Ok(prompt);
            }
        }
    }
    Ok(format!(
        "Handle this webhook payload:\n{}",
        serde_json::to_string_pretty(payload)?
    ))
}

fn prompt_from_value(value: &Value, empty_message: &str) -> Result<String, GatewayError> {
    let prompt = match value {
        Value::String(value) => value.trim().to_owned(),
        Value::Null => String::new(),
        Value::Bool(_) | Value::Number(_) => value.to_string(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string_pretty(value)?,
    };
    if prompt.trim().is_empty() {
        return Err(GatewayError::InvalidJsonMessage(empty_message.to_owned()));
    }
    Ok(prompt)
}

fn session_title(agent: &ManagedAgentRow, payload: &Value, config: &WebhookAgentConfig) -> String {
    let value = config_pointer(config.title_json_pointer.as_deref())
        .and_then(|pointer| payload.pointer(pointer))
        .and_then(title_value);
    match value {
        Some(value) => truncate_title(&format!("Webhook {value}")),
        None => truncate_title(&format!("Webhook {}", agent.name)),
    }
}

fn title_value(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => non_empty(value).map(str::to_owned),
        Value::Number(_) | Value::Bool(_) => Some(value.to_string()),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
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

fn config_pointer(value: Option<&str>) -> Option<&str> {
    value
        .and_then(non_empty)
        .filter(|value| value.starts_with('/'))
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
        verify_webhook_secret, webhook_prompt, WebhookAgentConfig,
    };
    use crate::{
        db::managed_agents::registry::schema::ManagedAgentRow, sdk::agents::CLAUDE_MANAGED_AGENTS,
    };

    #[test]
    fn verify_webhook_secret_accepts_configured_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-custom-webhook-secret",
            HeaderValue::from_static("secret-123"),
        );
        let config = WebhookAgentConfig {
            header_name: Some("x-custom-webhook-secret".to_owned()),
            ..Default::default()
        };

        assert!(verify_webhook_secret(&headers, &config, "secret-123").is_ok());
        assert!(verify_webhook_secret(&headers, &config, "different").is_err());
    }

    #[test]
    fn verify_webhook_secret_accepts_authorization_bearer() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer secret-123"),
        );

        assert!(
            verify_webhook_secret(&headers, &WebhookAgentConfig::default(), "secret-123").is_ok()
        );
        assert_eq!(authorization_token("bearer abc"), "abc");
    }

    #[test]
    fn webhook_prompt_prefers_configured_json_pointer() {
        let config = WebhookAgentConfig {
            prompt_json_pointer: Some("/ticket/description".to_owned()),
            ..Default::default()
        };

        let prompt = webhook_prompt(
            &json!({ "ticket": { "description": "Customer cannot log in" } }),
            &config,
        )
        .unwrap();

        assert_eq!(prompt, "Customer cannot log in");
    }

    #[test]
    fn webhook_prompt_uses_common_fields_then_full_payload() {
        assert_eq!(
            webhook_prompt(&json!({ "text": "hello" }), &WebhookAgentConfig::default()).unwrap(),
            "hello"
        );

        let prompt = webhook_prompt(
            &json!({ "ticket": { "id": 42 } }),
            &WebhookAgentConfig::default(),
        )
        .unwrap();

        assert!(prompt.contains("Handle this webhook payload:"));
        assert!(prompt.contains("\"id\": 42"));
    }

    #[test]
    fn session_title_uses_pointer_when_present() {
        let config = WebhookAgentConfig {
            title_json_pointer: Some("/ticket/id".to_owned()),
            ..Default::default()
        };

        assert_eq!(
            session_title(
                &agent(json!({})),
                &json!({ "ticket": { "id": 42 } }),
                &config
            ),
            "Webhook 42"
        );
        assert_eq!(
            session_title(
                &agent(json!({})),
                &json!({}),
                &WebhookAgentConfig::default()
            ),
            "Webhook Agent"
        );
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

    fn agent(config: serde_json::Value) -> ManagedAgentRow {
        ManagedAgentRow {
            id: "agent-1".to_owned(),
            name: "Agent".to_owned(),
            model: "openai/gpt-5-mini".to_owned(),
            system: "system".to_owned(),
            tools: json!([]),
            cadence: None,
            interval_seconds: None,
            session_id: Some("session-1".to_owned()),
            loop_id: None,
            created_at: 0,
            prompt: None,
            cron: None,
            timezone: "UTC".to_owned(),
            vault_keys: json!([]),
            setup_commands: json!([]),
            max_runtime_minutes: 30,
            on_failure: "pause".to_owned(),
            config,
            owner_id: None,
            status: "active".to_owned(),
            description: None,
            harness: CLAUDE_MANAGED_AGENTS.to_owned(),
            skill_ids: json!([]),
            rule_ids: json!([]),
        }
    }
}
