use serde_json::{json, Value};

use super::{
    super::{request_json, AppFixture},
    slack_helpers::{assert_slack_api_call_count, slack_api_call_count},
};

pub async fn enable_and_assert_slack_messages(fixture: &AppFixture, agent_id: &str) {
    let baselines = SlackCallBaselines::capture(fixture).await;
    enable_slack_mcp(fixture, agent_id).await;
    assert_channel_message(fixture, agent_id).await;
    assert_dm_message(fixture, agent_id).await;
    assert_created_channel(fixture, agent_id).await;
    baselines.assert_counts(fixture).await;
    disable_slack_mcp(fixture, agent_id).await;
}

struct SlackCallBaselines {
    post_message: usize,
    lookup_email: usize,
}

impl SlackCallBaselines {
    async fn capture(fixture: &AppFixture) -> Self {
        Self {
            post_message: slack_api_call_count(fixture, "/chat.postMessage").await,
            lookup_email: slack_api_call_count(fixture, "/users.lookupByEmail").await,
        }
    }

    async fn assert_counts(&self, fixture: &AppFixture) {
        assert_slack_api_call_count(fixture, "/users.lookupByEmail", self.lookup_email + 2).await;
        assert_slack_api_call_count(fixture, "/conversations.open", 1).await;
        assert_slack_api_call_count(fixture, "/conversations.create", 1).await;
        assert_slack_api_call_count(fixture, "/conversations.invite", 1).await;
        assert_slack_api_call_count(fixture, "/chat.postMessage", self.post_message + 2).await;
    }
}

async fn enable_slack_mcp(fixture: &AppFixture, agent_id: &str) {
    request_json(
        fixture.app.clone(),
        "PATCH",
        &format!("/api/agents/{agent_id}"),
        Some(json!({
            "config": {
                "platform_mcp_ids": ["send_slack_message", "create_slack_channel"],
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

async fn assert_channel_message(fixture: &AppFixture, agent_id: &str) {
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
}

async fn assert_dm_message(fixture: &AppFixture, agent_id: &str) {
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
}

async fn assert_created_channel(fixture: &AppFixture, agent_id: &str) {
    let channel = call_create_slack_channel(
        fixture,
        agent_id,
        json!({
            "name": "Incident War Room",
            "is_private": true,
            "user_ids": ["U123"],
            "emails": ["teammate@example.com"]
        }),
    )
    .await;
    assert_eq!(channel["channel_id"], "C-WAR");
    assert_eq!(channel["name"], "incident-war-room");
    assert_eq!(channel["is_private"], true);
    assert_eq!(channel["invited_user_ids"], json!(["U123", "U-DM"]));
    assert_eq!(channel["invite_error"], Value::Null);
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

async fn call_create_slack_channel(
    fixture: &AppFixture,
    agent_id: &str,
    arguments: Value,
) -> Value {
    let response = request_json(
        fixture.app.clone(),
        "POST",
        &format!("/mcp/platform/{agent_id}"),
        Some(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "create_slack_channel",
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
