#[path = "managed_agents_support/mod.rs"]
mod support;

use serde_json::{json, Value};
use support::{flows, request_json, request_json_raw, AppFixture};

static DB_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn mcp_proxy_base_url_setting_round_trip_against_postgres() {
    let _guard = DB_TEST_LOCK.lock().await;
    let Some(fixture) = AppFixture::new().await else {
        eprintln!("skipping managed agent integration test: TEST_DATABASE_URL is not set");
        return;
    };

    let initial = request_json(
        fixture.app.clone(),
        "GET",
        "/v1/mcp/settings/proxy-base-url",
        None,
    )
    .await;
    assert_eq!(initial["proxy_base_url"], "http://localhost");
    assert_eq!(initial["source"], "config");

    let saved = request_json(
        fixture.app.clone(),
        "PUT",
        "/v1/mcp/settings/proxy-base-url",
        Some(json!({ "proxy_base_url": "https://gateway.example.com/" })),
    )
    .await;
    assert_eq!(saved["proxy_base_url"], "https://gateway.example.com");
    assert_eq!(saved["source"], "database");
    assert_eq!(
        litellm_rust::http::platform_mcps::platform_mcp_url(&fixture.state, "agent_test", None)
            .unwrap(),
        "https://gateway.example.com/mcp/platform/agent_test"
    );

    let (status, body) = request_json_raw(
        fixture.app.clone(),
        "PUT",
        "/v1/mcp/settings/proxy-base-url",
        Some(json!({ "proxy_base_url": "localhost:4000" })),
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    assert!(body.contains("absolute http(s) URL"));

    let cleared = request_json(
        fixture.app.clone(),
        "PUT",
        "/v1/mcp/settings/proxy-base-url",
        Some(json!({ "proxy_base_url": null })),
    )
    .await;
    assert_eq!(cleared["proxy_base_url"], "http://localhost");
    assert_eq!(cleared["source"], "config");
    assert_eq!(
        litellm_rust::http::platform_mcps::platform_mcp_url(&fixture.state, "agent_test", None)
            .unwrap(),
        "http://localhost/mcp/platform/agent_test"
    );
}

#[tokio::test]
async fn managed_agent_endpoints_round_trip_against_postgres() {
    let _guard = DB_TEST_LOCK.lock().await;
    let Some(fixture) = AppFixture::new().await else {
        eprintln!("skipping managed agent integration test: TEST_DATABASE_URL is not set");
        return;
    };

    flows::assert_agent_runtime_catalog(&fixture).await;
    let agent_id = flows::create_agent(&fixture).await;
    flows::exercise_agent_lifecycle(&fixture, &agent_id).await;
    flows::exercise_agent_runtime_update(&fixture, &agent_id).await;
    flows::exercise_memory(&fixture, &agent_id).await;
    flows::exercise_platform_mcps(&fixture, &agent_id).await;
    flows::exercise_files(&fixture, &agent_id).await;
    flows::exercise_rules(&fixture, &agent_id).await;
    flows::exercise_runs(&fixture, &agent_id).await;
    flows::exercise_routines(&fixture, &agent_id).await;
    flows::exercise_slack(&fixture, &agent_id).await;
    flows::exercise_sessions(&fixture).await;
    flows::exercise_claude_runtime_session_storage(&fixture, &agent_id).await;
    flows::exercise_cursor_runtime_stream(&fixture, &agent_id).await;
    flows::exercise_gemini_runtime_session(&fixture).await;
    flows::exercise_skills(&fixture).await;
    flows::exercise_inbox(&fixture).await;

    request_json(
        fixture.app.clone(),
        "DELETE",
        &format!("/api/agents/{agent_id}"),
        None,
    )
    .await;
}

#[tokio::test]
async fn rejects_invalid_file_base64_against_postgres() {
    let _guard = DB_TEST_LOCK.lock().await;
    let Some(fixture) = AppFixture::new().await else {
        eprintln!("skipping managed agent integration test: TEST_DATABASE_URL is not set");
        return;
    };

    let agent_id = flows::create_agent(&fixture).await;
    support::request_raw(
        fixture.app.clone(),
        "PUT",
        &format!("/api/agents/{agent_id}/files/bad.xlsx"),
        Some(json!({"content_base64": "not base64 !!!"}).to_string()),
        "application/json",
        axum::http::StatusCode::BAD_REQUEST,
    )
    .await;
}

#[tokio::test]
async fn runtime_agent_create_keeps_legacy_harness_against_postgres() {
    let _guard = DB_TEST_LOCK.lock().await;
    let Some(fixture) = AppFixture::new().await else {
        eprintln!("skipping managed agent integration test: TEST_DATABASE_URL is not set");
        return;
    };

    let created = create_test_agent(
        &fixture,
        json!({
            "name": "runtime-agent",
            "owner_id": "user-1",
            "runtime": "claude_managed_agents",
            "harness": "claude_managed_agents"
        }),
    )
    .await;
    assert_eq!(created["harness"], "claude-code");
    assert!(created["tools"].is_null());
    assert_eq!(created["config"]["runtime"], "claude_managed_agents");
}

#[tokio::test]
async fn runtime_agent_create_preserves_tool_config_against_postgres() {
    let _guard = DB_TEST_LOCK.lock().await;
    let Some(fixture) = AppFixture::new().await else {
        eprintln!("skipping managed agent integration test: TEST_DATABASE_URL is not set");
        return;
    };

    let explicit_empty_tools = create_test_agent(
        &fixture,
        json!({
            "name": "empty-tools-agent",
            "owner_id": "user-1",
            "runtime": "claude_managed_agents",
            "tools": []
        }),
    )
    .await;
    assert_eq!(explicit_empty_tools["tools"], json!([]));
    assert_eq!(
        explicit_empty_tools["config"]["runtime"],
        "claude_managed_agents"
    );
    assert_eq!(explicit_empty_tools["config"]["tools"], json!([]));

    let overriding_tools = create_test_agent(
        &fixture,
        json!({
            "name": "overriding-tools-agent",
            "owner_id": "user-1",
            "runtime": "claude_managed_agents",
            "tools": [],
            "config": { "tools": [{ "type": "bash" }] }
        }),
    )
    .await;
    assert_eq!(overriding_tools["tools"], json!([]));
    assert_eq!(overriding_tools["config"]["tools"], json!([]));

    let normalized_config = create_test_agent(
        &fixture,
        json!({
            "name": "normalized-config-agent",
            "owner_id": "user-1",
            "runtime": "claude_managed_agents",
            "tools": [],
            "config": "invalid"
        }),
    )
    .await;
    assert_eq!(
        normalized_config["config"]["runtime"],
        "claude_managed_agents"
    );
    assert_eq!(normalized_config["config"]["tools"], json!([]));
}

async fn create_test_agent(fixture: &AppFixture, body: Value) -> Value {
    request_json(fixture.app.clone(), "POST", "/api/agents", Some(body)).await
}
