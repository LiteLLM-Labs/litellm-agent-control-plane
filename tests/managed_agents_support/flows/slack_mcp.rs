use serde_json::{json, Value};

use super::{
    super::{request_json, AppFixture},
    slack_helpers::{assert_slack_api_call_count, slack_api_call_count},
};

pub async fn enable_and_assert_slack_messages(fixture: &AppFixture, agent_id: &str) {
    let post_baseline = slack_api_call_count(fixture, "/chat.postMessage").await;
    request_json(
        fixture.app.clone(),
        "PATCH",
        &format!("/api/agents/{agent_id}"),
        Some(json!({
            "config": {
                "platform_mcp_ids": ["send_slack_message"],
                "slack": {
                    "status": "connected",
                    "client_id": "client-id",
                    "client_secret_key": format!("SLACK_{agent_id}_CLIENT_SECRET"),
                    "signing_secret_key": format!("SLACK_{agent_id}_SIGNING_SECRET"),
                    "bot_token_key": format!("SLACK_{agent_id}_BOT_TOKEN")
                }
            }
        })),
    )
    .await;

    let channel = call_send_slack_message(
        fixture,
        agent_id,
        json!({
            "channel_id": "C123",
            "text": "hello channel"
        }),
    )
    .await;
    assert_eq!(channel["channel_id"], "C123");
    assert_eq!(channel["ts"], "200.000001");

    let dm = call_send_slack_message(
        fixture,
        agent_id,
        json!({
            "email": "teammate@example.com",
            "text": "hello dm"
        }),
    )
    .await;
    assert_eq!(dm["user_id"], "U-DM");
    assert_eq!(dm["channel_id"], "D123");
    assert_eq!(dm["ts"], "200.000001");

    assert_slack_api_call_count(fixture, "/users.lookupByEmail", 1).await;
    assert_slack_api_call_count(fixture, "/conversations.open", 1).await;
    assert_slack_api_call_count(fixture, "/chat.postMessage", post_baseline + 2).await;
    disable_slack_mcp(fixture, agent_id).await;
}

async fn call_send_slack_message(fixture: &AppFixture, agent_id: &str, arguments: Value) -> Value {
    let response = request_json(
        fixture.app.clone(),
        "POST",
        &format!("/mcp/platform/{agent_id}"),
        Some(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "send_slack_message",
                "arguments": arguments
            }
        })),
    )
    .await;
    let text = response["result"]["content"][0]["text"].as_str().unwrap();
    serde_json::from_str(text).unwrap()
}

async fn disable_slack_mcp(fixture: &AppFixture, agent_id: &str) {
    request_json(
        fixture.app.clone(),
        "PATCH",
        &format!("/api/agents/{agent_id}"),
        Some(json!({
            "config": {
                "platform_mcp_ids": [],
                "slack": {
                    "status": "connected",
                    "client_id": "client-id",
                    "client_secret_key": format!("SLACK_{agent_id}_CLIENT_SECRET"),
                    "signing_secret_key": format!("SLACK_{agent_id}_SIGNING_SECRET"),
                    "bot_token_key": format!("SLACK_{agent_id}_BOT_TOKEN")
                }
            }
        })),
    )
    .await;
}
