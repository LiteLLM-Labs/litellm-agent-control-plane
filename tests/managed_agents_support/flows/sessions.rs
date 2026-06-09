use axum::http::StatusCode;
use serde_json::{json, Value};

use super::super::{read_events_until_completed, request_json, request_raw, AppFixture};

pub async fn exercise_sessions(fixture: &AppFixture) {
    let session_id = create_session(fixture).await;
    assert_session_listed(fixture, &session_id).await;
    assert_initial_messages(fixture, &session_id).await;
    send_session_prompt(fixture, &session_id).await;
    assert_session_events(fixture, &session_id).await;
    assert_session_messages(fixture, &session_id).await;
    delete_session(fixture, &session_id).await;
}

async fn create_session(fixture: &AppFixture) -> String {
    let session = request_json(
        fixture.app.clone(),
        "POST",
        "/session",
        Some(json!({"agent": "claude-code", "title": "chat proof"})),
    )
    .await;
    let session_id = session["id"].as_str().unwrap().to_owned();
    assert!(session_id.starts_with("ses_"));
    assert_eq!(session["title"], "chat proof");
    assert_eq!(session["harness"], "claude-code");
    session_id
}

async fn assert_session_listed(fixture: &AppFixture, session_id: &str) {
    let listed = request_json(fixture.app.clone(), "GET", "/session", None).await;
    assert!(listed
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == session_id));
}

async fn assert_initial_messages(fixture: &AppFixture, session_id: &str) {
    let initial_messages = session_messages(fixture, session_id).await;
    assert_eq!(initial_messages.as_array().unwrap().len(), 0);
}

async fn send_session_prompt(fixture: &AppFixture, session_id: &str) {
    request_raw(
        fixture.app.clone(),
        "POST",
        &format!("/session/{session_id}/prompt_async"),
        Some(
            json!({
                "model": {"providerID": "litellm", "modelID": "claude-sonnet-4-6"},
                "parts": [{"type": "text", "text": "say hello"}]
            })
            .to_string(),
        ),
        "application/json",
        StatusCode::NO_CONTENT,
    )
    .await;
}

async fn assert_session_events(fixture: &AppFixture, session_id: &str) {
    let events = read_events_until_completed(fixture.app.clone(), "/event", session_id).await;
    assert!(events.contains("\"type\":\"message.part.delta\""));
    assert!(events.contains("\"delta\":\"hello \""));
    assert!(events.contains("\"delta\":\"from managed agent\\n\""));
}

async fn assert_session_messages(fixture: &AppFixture, session_id: &str) {
    let messages = session_messages(fixture, session_id).await;
    assert_eq!(messages.as_array().unwrap().len(), 2);
    assert_eq!(messages[0]["info"]["role"], "user");
    assert_eq!(messages[0]["parts"][0]["text"], "say hello");
    assert_eq!(messages[1]["info"]["role"], "assistant");
    assert_eq!(messages[1]["info"]["id"], session_id);
    assert_eq!(messages[1]["parts"][0]["id"], format!("{session_id}_text"));
    assert_eq!(
        messages[1]["parts"][0]["text"],
        "hello from managed agent\n"
    );
}

async fn session_messages(fixture: &AppFixture, session_id: &str) -> Value {
    request_json(
        fixture.app.clone(),
        "GET",
        &format!("/session/{session_id}/message"),
        None,
    )
    .await
}

async fn delete_session(fixture: &AppFixture, session_id: &str) {
    let deleted = request_json(
        fixture.app.clone(),
        "DELETE",
        &format!("/session/{session_id}"),
        None,
    )
    .await;
    assert_eq!(deleted, true);
}
