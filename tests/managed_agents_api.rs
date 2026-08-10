#[path = "managed_agents_support/mod.rs"]
mod support;

use serde_json::{json, Value};
use std::sync::Arc;
use support::{flows, request_json, request_json_raw, AppFixture};

static DB_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn runtime_event_appends_are_serialized_per_session() {
    let _guard = DB_TEST_LOCK.lock().await;
    let Some(fixture) = AppFixture::new().await else {
        eprintln!("skipping managed agent integration test: TEST_DATABASE_URL is not set");
        return;
    };
    let session = request_json(
        fixture.app.clone(),
        "POST",
        "/session",
        Some(json!({"agent": "claude-code", "title": "concurrent event writes"})),
    )
    .await;
    let session_id = session["id"].as_str().unwrap().to_owned();
    let barrier = Arc::new(tokio::sync::Barrier::new(32));
    let mut appends = tokio::task::JoinSet::new();

    for index in 0..32 {
        let pool = fixture.pool.clone();
        let session_id = session_id.clone();
        let barrier = barrier.clone();
        appends.spawn(async move {
            barrier.wait().await;
            litellm_rust::db::managed_agents::runtime_events::repository::append(
                &pool,
                &session_id,
                json!({"id": format!("evt_{index}"), "type": "agent.message"}),
            )
            .await
        });
    }

    while let Some(result) = appends.join_next().await {
        result.unwrap().unwrap();
    }
    let events = litellm_rust::db::managed_agents::runtime_events::repository::list(
        &fixture.pool,
        &session_id,
    )
    .await
    .unwrap();
    assert_eq!(events.len(), 32);
}

#[tokio::test]
async fn mcp_proxy_base_url_setting_round_trip_against_postgres() {
    let _guard = DB_TEST_LOCK.lock().await;
    let Some(fixture) = AppFixture::new().await else {
        eprintln!("skipping managed agent integration test: TEST_DATABASE_URL is not set");
        return;
    };

    assert_initial_proxy_base_url(&fixture).await;
    assert_saved_proxy_base_url(&fixture).await;
    assert_invalid_proxy_base_url_rejected(&fixture).await;
    assert_cleared_proxy_base_url(&fixture).await;
}

async fn assert_initial_proxy_base_url(fixture: &AppFixture) {
    let initial = request_json(
        fixture.app.clone(),
        "GET",
        "/v1/mcp/settings/proxy-base-url",
        None,
    )
    .await;
    assert_eq!(initial["proxy_base_url"], "http://localhost");
    assert_eq!(initial["source"], "config");
}

async fn assert_saved_proxy_base_url(fixture: &AppFixture) {
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
}

async fn assert_invalid_proxy_base_url_rejected(fixture: &AppFixture) {
    let (status, body) = request_json_raw(
        fixture.app.clone(),
        "PUT",
        "/v1/mcp/settings/proxy-base-url",
        Some(json!({ "proxy_base_url": "localhost:4000" })),
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    assert!(body.contains("absolute http(s) URL"));
}

async fn assert_cleared_proxy_base_url(fixture: &AppFixture) {
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
    flows::exercise_routines(&fixture, &agent_id).await;
    flows::exercise_agent_runtime_update(&fixture, &agent_id).await;
    flows::exercise_memory(&fixture, &agent_id).await;
    flows::exercise_platform_mcps(&fixture, &agent_id).await;
    flows::exercise_files(&fixture, &agent_id).await;
    flows::exercise_rules(&fixture, &agent_id).await;
    flows::exercise_runs(&fixture, &agent_id).await;
    flows::exercise_runtime_routine(&fixture).await;
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
async fn runtime_model_discovery_requires_credentials_against_postgres() {
    let _guard = DB_TEST_LOCK.lock().await;
    let Some(fixture) = AppFixture::new().await else {
        eprintln!("skipping managed agent integration test: TEST_DATABASE_URL is not set");
        return;
    };

    let (status, body) = request_json_raw(
        fixture.app.clone(),
        "GET",
        "/v1/models?runtime=cursor",
        None,
    )
    .await;

    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    assert!(body.contains("Cursor provider credentials are not configured"));
}

#[tokio::test]
async fn gemini_runtime_models_are_unsupported_against_postgres() {
    let _guard = DB_TEST_LOCK.lock().await;
    let Some(fixture) = AppFixture::new().await else {
        eprintln!("skipping managed agent integration test: TEST_DATABASE_URL is not set");
        return;
    };

    let (status, body) = request_json_raw(
        fixture.app.clone(),
        "GET",
        "/v1/models?runtime=gemini_antigravity",
        None,
    )
    .await;

    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    assert!(body.contains("model discovery is not supported for runtime: gemini_antigravity"));
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

    assert_explicit_empty_tools_preserved(&fixture).await;
    assert_top_level_tools_override_config_tools(&fixture).await;
    assert_invalid_config_normalized(&fixture).await;
}

async fn assert_explicit_empty_tools_preserved(fixture: &AppFixture) {
    let explicit_empty_tools = create_test_agent(
        fixture,
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
}

async fn assert_top_level_tools_override_config_tools(fixture: &AppFixture) {
    let overriding_tools = create_test_agent(
        fixture,
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
}

async fn assert_invalid_config_normalized(fixture: &AppFixture) {
    let normalized_config = create_test_agent(
        fixture,
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

#[tokio::test]
async fn claude_runtime_session_reuses_gateway_mcp_vault_against_postgres() {
    let _guard = DB_TEST_LOCK.lock().await;
    let Some(fixture) = AppFixture::new().await else {
        eprintln!("skipping managed agent integration test: TEST_DATABASE_URL is not set");
        return;
    };

    flows::exercise_claude_gateway_mcp_vault(&fixture).await;
}

async fn create_test_agent(fixture: &AppFixture, body: Value) -> Value {
    request_json(fixture.app.clone(), "POST", "/api/agents", Some(body)).await
}
