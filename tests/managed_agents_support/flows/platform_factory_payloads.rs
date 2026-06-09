use serde_json::{json, Value};

use super::slack_helpers::now_seconds;

pub(super) fn slack_config(agent_id: &str, status: &str) -> Value {
    json!({
        "config": {
            "slack": {
                "status": status,
                "client_id": "client-id",
                "app_config_token_key": format!("SLACK_{agent_id}_APP_CONFIG_TOKEN"),
                "client_secret_key": format!("SLACK_{agent_id}_CLIENT_SECRET"),
                "signing_secret_key": format!("SLACK_{agent_id}_SIGNING_SECRET"),
                "bot_token_key": format!("SLACK_{agent_id}_BOT_TOKEN")
            }
        }
    })
}

pub(super) fn child_message_body() -> String {
    json!({
        "type": "event_callback",
        "team_id": "T123",
        "api_app_id": "A123",
        "event_id": "Ev-factory-child",
        "event_time": now_seconds(),
        "event": {
            "type": "app_mention",
            "user": "U123",
            "text": "<@B123> what should I ship?",
            "ts": "1712345679.000100",
            "channel": "C-factory",
            "event_ts": "1712345679.000100"
        }
    })
    .to_string()
}

pub(super) fn unrelated_message_body() -> String {
    json!({
        "type": "event_callback",
        "team_id": "T123",
        "api_app_id": "A123",
        "event_id": "Ev-factory-unrelated",
        "event_time": now_seconds(),
        "event": {
            "type": "app_mention",
            "user": "U123",
            "text": "<@B123> should stay with the factory",
            "ts": "1712345688.000100",
            "channel": "C-factory",
            "event_ts": "1712345688.000100"
        }
    })
    .to_string()
}

pub(super) fn install_call(child_agent_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "tools/call",
        "params": {
            "name": "connect_agent_to_slack",
            "arguments": {
                "agent_id": child_agent_id,
                "team_id": "T999",
                "channel_id": "C-install",
                "thread_ts": "1712345680.000100",
                "requested_by": "U999"
            }
        }
    })
}
