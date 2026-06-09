use axum::http::StatusCode;
use serde_json::json;

use crate::support::{request_raw, AppFixture};

use super::slack_helpers::signed_json_request;

pub async fn assert_url_verification(fixture: &AppFixture, agent_id: &str) {
    let body = json!({
        "type": "url_verification",
        "challenge": "challenge-ok"
    })
    .to_string();
    let response = signed_json_request(
        fixture,
        &format!("/api/agents/{agent_id}/slack/events"),
        body,
        StatusCode::OK,
    )
    .await;
    assert_eq!(response, "challenge-ok");
}

pub async fn assert_url_verification_without_secret(fixture: &AppFixture, agent_id: &str) {
    request_raw(
        fixture.app.clone(),
        "DELETE",
        &format!("/api/vault/default/SLACK_{agent_id}_SIGNING_SECRET"),
        None,
        "application/json",
        StatusCode::OK,
    )
    .await;
    let body = json!({
        "type": "url_verification",
        "challenge": "unsigned-challenge-ok"
    })
    .to_string();
    let response = request_raw(
        fixture.app.clone(),
        "POST",
        &format!("/api/agents/{agent_id}/slack/events"),
        Some(body),
        "application/json",
        StatusCode::OK,
    )
    .await;
    assert_eq!(response, "unsigned-challenge-ok");
    super::slack::save_slack_secrets(fixture, agent_id).await;
}
