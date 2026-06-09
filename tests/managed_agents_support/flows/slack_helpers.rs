use axum::http::StatusCode;
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::Sha256;

use super::{
    super::{request_json, request_with_headers, AppFixture},
    slack_url_verification::assert_url_verification,
};

pub(super) async fn assert_slack_api_called(fixture: &AppFixture, path: &str) {
    for _ in 0..20 {
        let requests = fixture.slack.received_requests().await.unwrap();
        if requests.iter().any(|request| request.url.path() == path) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("slack mock did not receive {path}");
}

pub(super) async fn assert_slack_api_call_count(fixture: &AppFixture, path: &str, expected: usize) {
    for _ in 0..20 {
        if slack_api_call_count(fixture, path).await == expected {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(
        slack_api_call_count(fixture, path).await,
        expected,
        "unexpected call count for {path}"
    );
}

pub(super) async fn assert_legacy_prefixed_slack_secret(fixture: &AppFixture, agent_id: &str) {
    let key = format!("SLACK_{agent_id}_SIGNING_SECRET");
    request_json(
        fixture.app.clone(),
        "DELETE",
        &format!("/api/vault/default/{key}"),
        None,
    )
    .await;
    request_json(
        fixture.app.clone(),
        "POST",
        "/api/vault/default",
        Some(json!({
            "key": format!("vault:default:{key}"),
            "value": "slack-secret",
        })),
    )
    .await;
    assert_url_verification(fixture, agent_id).await;
    request_json(
        fixture.app.clone(),
        "POST",
        "/api/vault/default",
        Some(json!({ "key": key, "value": "slack-secret" })),
    )
    .await;
}

pub(super) fn provider_id_for(agent_id: &str) -> String {
    agent_id.to_lowercase().replace('_', "-")
}

pub(super) async fn signed_json_request(
    fixture: &AppFixture,
    uri: &str,
    body: String,
    expected: StatusCode,
) -> String {
    signed_request(fixture, uri, body, "application/json", expected).await
}

pub(super) async fn signed_request(
    fixture: &AppFixture,
    uri: &str,
    body: String,
    content_type: &str,
    expected: StatusCode,
) -> String {
    let timestamp = now_seconds();
    request_with_headers(
        fixture.app.clone(),
        "POST",
        uri,
        body.clone(),
        content_type,
        &[
            ("x-slack-request-timestamp", timestamp.to_string()),
            (
                "x-slack-signature",
                slack_signature(timestamp, body.as_bytes(), "slack-secret"),
            ),
        ],
        expected,
    )
    .await
}

pub(super) fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            byte => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub(super) fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

pub(super) async fn slack_api_call_count(fixture: &AppFixture, path: &str) -> usize {
    fixture
        .slack
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|request| request.url.path() == path)
        .count()
}

fn slack_signature(timestamp: i64, body: &[u8], signing_secret: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(signing_secret.as_bytes()).unwrap();
    mac.update(format!("v0:{timestamp}:").as_bytes());
    mac.update(body);
    format!("v0={}", lower_hex(&mac.finalize().into_bytes()))
}

fn lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
