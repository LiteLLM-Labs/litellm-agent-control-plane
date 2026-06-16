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
    headers.insert("x-request-id", HeaderValue::from_static("proxy-123"));
    headers.insert("x-zendesk-webhook-id", HeaderValue::from_static("zd-123"));

    assert_eq!(request_id(&headers), "zd-123");
}

#[test]
fn constant_time_eq_matches_equal_strings() {
    assert!(constant_time_eq("abc", "abc"));
    assert!(!constant_time_eq("abc", "abd"));
    assert!(!constant_time_eq("abc", "ab"));
    assert!(!constant_time_eq("abc", "abcd"));
}

#[test]
fn truncate_title_handles_multibyte_characters() {
    let title = truncate_title(&format!("Webhook {}", "\u{00e9}".repeat(130)));

    assert!(title.ends_with("..."));
    assert!(title.is_char_boundary(title.len() - 3));
}
