use axum::http::StatusCode;
use serde_json::{json, Value};
use wiremock::{
    matchers::{body_json, header, method, path},
    Mock, MockServer, ResponseTemplate,
};

use super::super::{request_json, request_json_raw, request_raw, AppFixture};

const CURSOR_AGENT_ID: &str = "bc-11111111-1111-1111-1111-111111111111";
const FIRST_RUN_ID: &str = "run-11111111-1111-1111-1111-111111111111";
const SECOND_RUN_ID: &str = "run-22222222-2222-2222-2222-222222222222";

pub async fn exercise_cursor_runtime_stream(fixture: &AppFixture, agent_id: &str) {
    let cursor = MockServer::start().await;
    let create_agent_request = cursor_create_agent_request();
    assert_cursor_repo_config(&create_agent_request);
    mount_create_agent(&cursor, create_agent_request).await;
    mount_run_stream(&cursor, FIRST_RUN_ID, "gateway", " stream").await;
    mount_followup_run(&cursor).await;
    mount_run_stream(&cursor, SECOND_RUN_ID, "followup", " stream").await;

    save_cursor_credentials(fixture, &cursor).await;
    let session_id = create_cursor_session(fixture, &cursor, agent_id).await;
    assert_initial_stream(fixture, &session_id).await;
    assert_session_status(fixture, &session_id, "idle").await;
    send_followup_prompt(fixture, &session_id).await;
    assert_updated_run(fixture, &session_id).await;
    assert_followup_stream(fixture, &session_id).await;
    assert_session_status(fixture, &session_id, "idle").await;
    mount_interrupt_run(&cursor).await;
    interrupt_session(fixture, &session_id).await;
    assert_interrupt_does_not_emit_abort_error(fixture, &session_id).await;
}

async fn mount_create_agent(cursor: &MockServer, request: Value) {
    Mock::given(method("POST"))
        .and(path("/v1/agents"))
        .and(header("authorization", "Bearer cursor-test"))
        .and(body_json(request))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "agent": {
                "id": CURSOR_AGENT_ID,
                "status": "ACTIVE",
                "latestRunId": FIRST_RUN_ID
            },
            "run": {
                "id": FIRST_RUN_ID,
                "agentId": CURSOR_AGENT_ID,
                "status": "CREATING"
            }
        })))
        .mount(cursor)
        .await;
}

async fn mount_run_stream(cursor: &MockServer, run_id: &str, first: &str, second: &str) {
    Mock::given(method("GET"))
        .and(path(format!(
            "/v1/agents/{CURSOR_AGENT_ID}/runs/{run_id}/stream"
        )))
        .and(header("authorization", "Bearer cursor-test"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(stream_body(run_id, first, second)),
        )
        .mount(cursor)
        .await;
}

async fn mount_followup_run(cursor: &MockServer) {
    Mock::given(method("POST"))
        .and(path(format!("/v1/agents/{CURSOR_AGENT_ID}/runs")))
        .and(header("authorization", "Bearer cursor-test"))
        .and(body_json(json!({
            "prompt": { "text": "Follow up on the test failure" }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "run": {
                "id": SECOND_RUN_ID,
                "agentId": CURSOR_AGENT_ID,
                "status": "CREATING"
            }
        })))
        .mount(cursor)
        .await;
}

async fn mount_interrupt_run(cursor: &MockServer) {
    Mock::given(method("POST"))
        .and(path(format!(
            "/v1/agents/{CURSOR_AGENT_ID}/runs/{SECOND_RUN_ID}/cancel"
        )))
        .and(header("authorization", "Bearer cursor-test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(cursor)
        .await;
}

async fn save_cursor_credentials(fixture: &AppFixture, cursor: &MockServer) {
    request_json(
        fixture.app.clone(),
        "POST",
        "/api/providers/cursor",
        Some(json!({
            "api_key": "cursor-test",
            "api_base": cursor.uri()
        })),
    )
    .await;
    let response = request_json(fixture.app.clone(), "GET", "/api/agent-runtimes", None).await;
    let cursor_runtime = response["runtimes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|runtime| runtime["id"] == "cursor")
        .unwrap();
    assert_eq!(cursor_runtime["connected"], true);
    assert_eq!(cursor_runtime["credential_provider_id"], "cursor");
    assert_eq!(cursor_runtime["api_base"].as_str().unwrap(), cursor.uri());
}

async fn create_cursor_session(
    fixture: &AppFixture,
    cursor: &MockServer,
    agent_id: &str,
) -> String {
    let (status, body) = request_json_raw(
        fixture.app.clone(),
        "POST",
        "/session",
        Some(cursor_session_request(agent_id)),
    )
    .await;
    if !status.is_success() {
        if let Some(requests) = cursor.received_requests().await {
            for request in requests {
                eprintln!(
                    "cursor request: {} {} {}",
                    request.method,
                    request.url,
                    String::from_utf8_lossy(&request.body)
                );
            }
        }
        panic!("POST /session returned {status}: {body}");
    }
    let session: Value = serde_json::from_str(&body).unwrap();
    let session_id = session["id"].as_str().unwrap().to_owned();
    assert_eq!(session["runtime"], "cursor");
    assert_eq!(session["provider_session_id"], CURSOR_AGENT_ID);
    assert_eq!(session["provider_run_id"], FIRST_RUN_ID);
    session_id
}

async fn assert_initial_stream(fixture: &AppFixture, session_id: &str) {
    let events = runtime_events(fixture, session_id).await;
    assert!(events.contains("\"type\":\"session.status_running\""));
    assert!(events.contains("\"type\":\"agent.message\""));
    assert!(events.contains("gateway stream"));
    assert!(events.contains("\"type\":\"session.status_idle\""));
    assert!(!events.contains("cursor."));
}

async fn send_followup_prompt(fixture: &AppFixture, session_id: &str) {
    request_raw(
        fixture.app.clone(),
        "POST",
        &format!("/session/{session_id}/prompt_async"),
        Some(
            json!({
                "parts": [{
                    "type": "text",
                    "text": "Follow up on the test failure"
                }]
            })
            .to_string(),
        ),
        "application/json",
        StatusCode::NO_CONTENT,
    )
    .await;
}

async fn assert_updated_run(fixture: &AppFixture, session_id: &str) {
    let updated = request_json(
        fixture.app.clone(),
        "GET",
        &format!("/session/{session_id}"),
        None,
    )
    .await;
    assert_eq!(updated["provider_run_id"], SECOND_RUN_ID);
}

async fn assert_followup_stream(fixture: &AppFixture, session_id: &str) {
    let events = runtime_events(fixture, session_id).await;
    assert!(events.contains("\"type\":\"agent.message\""));
    assert!(events.contains("followup stream"));
    assert!(!events.contains("cursor."));
}

async fn assert_session_status(fixture: &AppFixture, session_id: &str, status: &str) {
    let session = request_json(
        fixture.app.clone(),
        "GET",
        &format!("/session/{session_id}"),
        None,
    )
    .await;
    assert_eq!(session["status"], status);
}

async fn interrupt_session(fixture: &AppFixture, session_id: &str) {
    request_raw(
        fixture.app.clone(),
        "POST",
        &format!("/session/{session_id}/interrupt"),
        None,
        "application/json",
        StatusCode::NO_CONTENT,
    )
    .await;
}

async fn assert_interrupt_does_not_emit_abort_error(fixture: &AppFixture, session_id: &str) {
    let events = request_json(
        fixture.app.clone(),
        "GET",
        &format!("/v1/sessions/{session_id}/events"),
        None,
    )
    .await
    .to_string();
    assert!(!events.contains("MessageAbortedError"));
    assert!(!events.contains("\"message\":\"aborted\""));
}

async fn runtime_events(fixture: &AppFixture, session_id: &str) -> String {
    request_raw(
        fixture.app.clone(),
        "GET",
        &format!("/v1/sessions/{session_id}/events/stream?key=sk-local"),
        None,
        "application/json",
        StatusCode::OK,
    )
    .await
}

fn cursor_create_agent_request() -> Value {
    json!({
        "prompt": { "text": "watch deploys\n\n---\n\n## Attached Rules\n### backend safety\nAlways use repository helpers before changing managed-agent DB code.\n\nRepository: https://github.com/acme/app\nBase branch: main\n\nFix the failing tests" },
        "model": { "id": "composer-2" },
        "name": "ops-agent",
        "repos": [{
            "url": "https://github.com/acme/app",
            "startingRef": "main"
        }],
        "autoCreatePR": true
    })
}

fn cursor_session_request(agent_id: &str) -> Value {
    json!({
        "runtime": "cursor",
        "agent_id": agent_id,
        "title": "cursor proof",
        "prompt": "Fix the failing tests",
        "environment": {
            "model": "composer-2",
            "repository": "https://github.com/acme/app",
            "ref": "main",
            "target_branch": "agent/cursor-proof",
            "auto_create_pr": true
        }
    })
}

fn assert_cursor_repo_config(request: &Value) {
    assert_eq!(request["repos"][0]["url"], "https://github.com/acme/app");
    assert_eq!(request["repos"][0]["startingRef"], "main");
    assert_eq!(request["autoCreatePR"], true);
}

fn stream_body(run_id: &str, first: &str, second: &str) -> String {
    format!(
        "event: status\n\
         data: {{\"runId\":\"{run_id}\",\"status\":\"RUNNING\"}}\n\n\
         event: assistant\n\
         data: {{\"text\":\"{first}\"}}\n\n\
         event: assistant\n\
         data: {{\"text\":\"{second}\"}}\n\n\
         event: result\n\
         data: {{\"runId\":\"{run_id}\",\"status\":\"FINISHED\"}}\n\n"
    )
}
