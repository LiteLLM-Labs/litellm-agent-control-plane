use serde_json::{json, Value};

use crate::support::{request_json, AppFixture};

use super::{
    platform_factory_oauth::assert_child_oauth_install,
    platform_factory_payloads::{
        child_message_body, install_call, slack_config, unrelated_message_body,
    },
    slack_helpers::{
        assert_slack_api_call_count, assert_slack_api_called, signed_json_request,
        slack_api_call_count,
    },
};

pub async fn assert_agent_factory(fixture: &AppFixture, platform_agent_id: &str) {
    let _anthropic = super::claude_runtime::save_anthropic_credentials(fixture).await;
    save_platform_slack(fixture, platform_agent_id, "connected").await;
    let child_id = create_child_agent(fixture, platform_agent_id).await;
    connect_child_agent(fixture, platform_agent_id, &child_id).await;
    assert_child_slack_app(fixture, &child_id).await;
    mark_child_slack_connected(fixture, &child_id).await;
    assert_factory_slack_dispatch(fixture, platform_agent_id, &child_id).await;
    assert_pending_install_url(fixture, platform_agent_id, &child_id).await;
}

async fn create_child_agent(fixture: &AppFixture, platform_agent_id: &str) -> String {
    let created = rpc(
        fixture,
        platform_agent_id,
        json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "create_managed_agent",
                "arguments": {
                    "name": "Release Buddy",
                    "instructions": "Answer release questions from Slack.",
                    "owner_id": "slack:U123"
                }
            }
        }),
    )
    .await;
    let created = content_json(&created);
    assert_eq!(created["agent"]["harness"], "claude_managed_agents");
    assert_eq!(
        created["agent"]["config"]["runtime"],
        "claude_managed_agents"
    );
    assert!(created["agent_url"]
        .as_str()
        .unwrap()
        .starts_with("http://localhost/agents/detail/?id=agent_"));
    created["agent"]["id"].as_str().unwrap().to_owned()
}

async fn connect_child_agent(fixture: &AppFixture, platform_agent_id: &str, child_id: &str) {
    let connected = rpc(
        fixture,
        platform_agent_id,
        json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "connect_agent_to_slack",
                "arguments": {
                    "agent_id": child_id,
                    "team_id": "T123",
                    "channel_id": "C-factory",
                    "thread_ts": "1712345679.000100",
                    "requested_by": "U123"
                }
            }
        }),
    )
    .await;
    let connected = content_json(&connected);
    assert_eq!(connected["status"], "slack_app_created");
    assert_eq!(
        connected["agent"]["config"]["slack"]["app_id"],
        "A-child-agent"
    );
    assert_eq!(
        connected["agent"]["config"]["slack"]["client_id"],
        "child-client-id"
    );
    assert_eq!(
        connected["agent_url"].as_str().unwrap(),
        format!("http://localhost/agents/detail/?id={child_id}")
    );
    assert!(connected["install_url"]
        .as_str()
        .unwrap()
        .contains("client_id=child-client-id"));
    assert!(connected["slack_display"]
        .as_str()
        .unwrap()
        .contains("dedicated Slack app"));
    assert_slack_api_called(fixture, "/apps.manifest.create").await;
    assert_child_oauth_install(fixture, platform_agent_id, child_id, &connected).await;
}

async fn assert_child_slack_app(fixture: &AppFixture, child_id: &str) {
    let child = request_json(
        fixture.app.clone(),
        "GET",
        &format!("/api/agents/{child_id}"),
        None,
    )
    .await;
    assert_eq!(child["config"]["slack"]["app_id"], "A-child-agent");
    assert_eq!(child["config"]["slack"]["client_id"], "child-client-id");
    assert_eq!(child["config"]["slack"]["status"], "connected");
    assert_eq!(
        child["config"]["slack"]["client_secret_key"],
        format!("SLACK_{child_id}_CLIENT_SECRET")
    );
    assert_eq!(
        child["config"]["slack"]["signing_secret_key"],
        format!("SLACK_{child_id}_SIGNING_SECRET")
    );
}

async fn save_platform_slack(fixture: &AppFixture, agent_id: &str, status: &str) {
    for (key, value) in [
        (format!("SLACK_{agent_id}_SIGNING_SECRET"), "slack-secret"),
        (format!("SLACK_{agent_id}_CLIENT_SECRET"), "client-secret"),
        (format!("SLACK_{agent_id}_BOT_TOKEN"), "xoxb-test"),
        (
            format!("SLACK_{agent_id}_APP_CONFIG_TOKEN"),
            "xapp-config-token",
        ),
    ] {
        request_json(
            fixture.app.clone(),
            "POST",
            "/api/vault/default",
            Some(json!({ "key": key, "value": value })),
        )
        .await;
    }
    request_json(
        fixture.app.clone(),
        "PATCH",
        &format!("/api/agents/{agent_id}"),
        Some(slack_config(agent_id, status)),
    )
    .await;
}

async fn mark_child_slack_connected(fixture: &AppFixture, child_id: &str) {
    let bot_token_key = format!("SLACK_{child_id}_BOT_TOKEN");
    request_json(
        fixture.app.clone(),
        "POST",
        "/api/vault/default",
        Some(json!({ "key": bot_token_key, "value": "xoxb-child-test" })),
    )
    .await;
    let child = request_json(
        fixture.app.clone(),
        "GET",
        &format!("/api/agents/{child_id}"),
        None,
    )
    .await;
    let mut config = child["config"].clone();
    config["slack"]["status"] = json!("connected");
    config["slack"]["bot_token_key"] = json!(format!("SLACK_{child_id}_BOT_TOKEN"));
    request_json(
        fixture.app.clone(),
        "PATCH",
        &format!("/api/agents/{child_id}"),
        Some(json!({ "config": config })),
    )
    .await;
}

async fn assert_factory_slack_dispatch(
    fixture: &AppFixture,
    platform_agent_id: &str,
    child_agent_id: &str,
) {
    let update_baseline = slack_api_call_count(fixture, "/chat.update").await;
    signed_json_request(
        fixture,
        &format!("/api/agents/{platform_agent_id}/slack/events"),
        child_message_body(),
        axum::http::StatusCode::OK,
    )
    .await;
    wait_for_child_thread(fixture, child_agent_id).await;
    assert_slack_api_call_count(fixture, "/chat.update", update_baseline + 1).await;
    signed_json_request(
        fixture,
        &format!("/api/agents/{platform_agent_id}/slack/events"),
        unrelated_message_body(),
        axum::http::StatusCode::OK,
    )
    .await;
    assert_no_child_thread(fixture, child_agent_id, "1712345688.000100").await;
}

async fn wait_for_child_thread(fixture: &AppFixture, child_agent_id: &str) -> String {
    for _ in 0..20 {
        let session_id: Option<String> = sqlx::query_scalar(
            r#"
            SELECT session_id
            FROM "LiteLLM_ManagedAgentSlackThreadSessionsTable"
            WHERE agent_id = $1 AND channel_id = 'C-factory'
            "#,
        )
        .bind(child_agent_id)
        .fetch_optional(&fixture.pool)
        .await
        .unwrap();
        if let Some(session_id) = session_id {
            return session_id;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("factory Slack event did not dispatch to child agent");
}

async fn assert_no_child_thread(fixture: &AppFixture, child_agent_id: &str, thread_ts: &str) {
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let session_id: Option<String> = sqlx::query_scalar(
        r#"
        SELECT session_id
        FROM "LiteLLM_ManagedAgentSlackThreadSessionsTable"
        WHERE agent_id = $1 AND channel_id = 'C-factory' AND thread_ts = $2
        "#,
    )
    .bind(child_agent_id)
    .bind(thread_ts)
    .fetch_optional(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(session_id, None);
}

async fn assert_pending_install_url(
    fixture: &AppFixture,
    platform_agent_id: &str,
    child_agent_id: &str,
) {
    save_platform_slack(fixture, platform_agent_id, "needs_install").await;
    let install = rpc(fixture, platform_agent_id, install_call(child_agent_id)).await;
    let install = content_json(&install);
    assert_eq!(install["status"], "slack_app_created");
    assert_eq!(
        install["agent_url"].as_str().unwrap(),
        format!("http://localhost/agents/detail/?id={child_agent_id}")
    );
    let install_url = install["install_url"].as_str().unwrap();
    assert!(install_url.starts_with("https://slack.com/oauth/v2/authorize?"));
    assert!(install_url.contains("client_id=child-client-id"));
    assert!(install_url.contains("redirect_uri=http%3A%2F%2Flocalhost%2Fhost-oauth-callback"));
}

async fn rpc(fixture: &AppFixture, agent_id: &str, body: Value) -> Value {
    request_json(
        fixture.app.clone(),
        "POST",
        &format!("/mcp/platform/{agent_id}"),
        Some(body),
    )
    .await
}

fn content_text(value: &Value) -> &str {
    value["result"]["content"][0]["text"].as_str().unwrap()
}

fn content_json(value: &Value) -> Value {
    serde_json::from_str(content_text(value)).unwrap()
}
