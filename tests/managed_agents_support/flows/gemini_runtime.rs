use serde_json::{json, Value};
use wiremock::{
    matchers::{body_json, header, method, path},
    Mock, MockServer, ResponseTemplate,
};

use super::super::{request_json, request_json_raw, AppFixture};

const GEMINI_INTERACTION_ID: &str = "interaction_111";

pub async fn exercise_gemini_runtime_session(fixture: &AppFixture) {
    let gemini = MockServer::start().await;
    mount_create_agent(&gemini).await;
    mount_interaction(&gemini).await;

    save_gemini_credentials(fixture, &gemini).await;
    let agent_id = create_gemini_agent(fixture).await;
    let session_id = create_gemini_session(fixture, &agent_id).await;
    assert_gemini_events(fixture, &session_id).await;
}

async fn mount_create_agent(gemini: &MockServer) {
    let gemini_agent_id = expected_gemini_agent_id();
    Mock::given(method("POST"))
        .and(path("/v1beta/agents"))
        .and(header("x-goog-api-key", "gemini-test"))
        .and(header("api-revision", "2026-05-20"))
        .and(body_json(json!({
            "id": gemini_agent_id,
            "base_agent": "antigravity-preview-05-2026",
            "system_instruction": "Reply to hi with a concise greeting.",
            "description": "Gemini runtime test agent.",
            "tools": [
                { "type": "code_execution" },
                { "type": "google_search" },
                { "type": "url_context" }
            ],
            "base_environment": "remote"
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": gemini_agent_id,
            "base_agent": "antigravity-preview-05-2026",
            "system_instruction": "Reply to hi with a concise greeting.",
            "description": "Gemini runtime test agent.",
            "tools": [
                { "type": "code_execution" },
                { "type": "google_search" },
                { "type": "url_context" }
            ]
        })))
        .mount(gemini)
        .await;
}

async fn mount_interaction(gemini: &MockServer) {
    let gemini_agent_id = expected_gemini_agent_id();
    Mock::given(method("POST"))
        .and(path("/v1beta/interactions"))
        .and(header("x-goog-api-key", "gemini-test"))
        .and(header("api-revision", "2026-05-20"))
        .and(body_json(json!({
            "agent": gemini_agent_id,
            "input": "hi",
            "environment": "remote",
            "store": true
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(running_interaction()))
        .mount(gemini)
        .await;

    Mock::given(method("GET"))
        .and(path(format!(
            "/v1beta/interactions/{GEMINI_INTERACTION_ID}"
        )))
        .and(header("x-goog-api-key", "gemini-test"))
        .and(header("api-revision", "2026-05-20"))
        .respond_with(ResponseTemplate::new(200).set_body_json(completed_interaction()))
        .mount(gemini)
        .await;
}

async fn save_gemini_credentials(fixture: &AppFixture, gemini: &MockServer) {
    let response = request_json(
        fixture.app.clone(),
        "PUT",
        "/api/agent-runtimes/gemini_antigravity/credentials",
        Some(json!({
            "api_key": "gemini-test",
            "api_base": gemini.uri()
        })),
    )
    .await;
    let gemini_runtime = response["runtimes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|runtime| runtime["id"] == "gemini_antigravity")
        .unwrap();
    assert_eq!(gemini_runtime["connected"], true);
    assert_eq!(gemini_runtime["credential_provider_id"], "gemini");
    assert_eq!(gemini_runtime["api_base"].as_str().unwrap(), gemini.uri());
}

async fn create_gemini_agent(fixture: &AppFixture) -> String {
    let agent = request_json(
        fixture.app.clone(),
        "POST",
        "/api/agents",
        Some(json!({
            "name": "Gemini Runtime Agent",
            "owner_id": "user-1",
            "runtime": "gemini_antigravity",
            "model": "antigravity-preview-05-2026",
            "system": "Reply to hi with a concise greeting.",
            "description": "Gemini runtime test agent."
        })),
    )
    .await;
    assert_eq!(agent["config"]["runtime"], "gemini_antigravity");
    agent["id"].as_str().unwrap().to_owned()
}

async fn create_gemini_session(fixture: &AppFixture, agent_id: &str) -> String {
    let (status, body) = request_json_raw(
        fixture.app.clone(),
        "POST",
        "/session",
        Some(json!({
            "title": "Gemini runtime session",
            "agent": agent_id,
            "agent_id": agent_id,
            "runtime": "gemini_antigravity",
            "prompt": "hi",
            "environment": {}
        })),
    )
    .await;
    assert!(
        status.is_success(),
        "POST /session returned {status}: {body}"
    );
    let session: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(session["runtime"], "gemini_antigravity");
    assert_eq!(session["provider_session_id"], "remote");
    let session_id = session["id"].as_str().unwrap().to_owned();
    let refreshed = request_json(
        fixture.app.clone(),
        "GET",
        &format!("/session/{session_id}"),
        None,
    )
    .await;
    assert_eq!(refreshed["provider_run_id"], GEMINI_INTERACTION_ID);
    assert_eq!(refreshed["status"], "idle");
    session_id
}

async fn assert_gemini_events(fixture: &AppFixture, session_id: &str) {
    let events = request_json(
        fixture.app.clone(),
        "GET",
        &format!("/v1/sessions/{session_id}/events"),
        None,
    )
    .await;
    assert_eq!(events["data"][0]["type"], "session.status_running");
    assert_eq!(events["data"][1]["type"], "agent.message");
    assert_eq!(events["data"][1]["content"][0]["text"], "Hi from Gemini.");
    assert_eq!(events["data"][2]["type"], "session.status_idle");
}

fn running_interaction() -> Value {
    json!({
        "object": "interaction",
        "id": GEMINI_INTERACTION_ID,
        "status": "in_progress"
    })
}

fn completed_interaction() -> Value {
    json!({
        "object": "interaction",
        "id": GEMINI_INTERACTION_ID,
        "status": "completed",
        "steps": [{
            "type": "model_output",
            "content": [{ "type": "text", "text": "Hi from Gemini." }]
        }]
    })
}

fn expected_gemini_agent_id() -> String {
    let payload = json!({
        "description": "Gemini runtime test agent.",
        "environment": {},
        "model": "antigravity-preview-05-2026",
        "system": "Reply to hi with a concise greeting.",
        "tools": [
            { "type": "code_execution" },
            { "type": "google_search" },
            { "type": "url_context" }
        ],
    });
    format!("gemini-runtime-agent-{}", stable_hash(&payload.to_string()))
}

fn stable_hash(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
