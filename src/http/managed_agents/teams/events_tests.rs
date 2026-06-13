use serde_json::{json, Value};

use super::{activity_endpoint, agent_runtime, incoming_message, TeamsActivity};
use crate::{
    db::managed_agents::registry::schema::ManagedAgentRow, errors::GatewayError,
    sdk::agents::CLAUDE_MANAGED_AGENTS,
};

#[test]
fn activity_endpoint_requires_service_url_before_filtering() {
    let activity = activity(json!({
        "type": "conversationUpdate",
        "channelId": "msteams"
    }));

    let error = activity_endpoint(&activity).unwrap_err();

    assert!(error.to_string().contains("teams serviceUrl is required"));
}

#[test]
fn activity_endpoint_rejects_non_teams_channel_id() {
    let activity = activity(json!({
        "type": "message",
        "serviceUrl": "https://smba.trafficmanager.net/amer/",
        "channelId": "webchat"
    }));

    assert!(matches!(
        activity_endpoint(&activity),
        Err(GatewayError::Unauthorized)
    ));
}

#[test]
fn incoming_message_ignores_bot_originated_messages() {
    let role_bot = incoming_message(
        activity(json!({
            "type": "message",
            "id": "activity-1",
            "serviceUrl": "https://smba.trafficmanager.net/amer/",
            "channelId": "msteams",
            "from": { "id": "28:bot", "role": "bot" },
            "recipient": { "id": "29:user" },
            "conversation": { "id": "conv-1" },
            "text": "hello"
        })),
        "https://smba.trafficmanager.net/amer/".to_owned(),
    );
    let same_account = incoming_message(
        activity(json!({
            "type": "message",
            "id": "activity-1",
            "serviceUrl": "https://smba.trafficmanager.net/amer/",
            "channelId": "msteams",
            "from": { "id": "28:bot" },
            "recipient": { "id": "28:bot" },
            "conversation": { "id": "conv-1" },
            "text": "hello"
        })),
        "https://smba.trafficmanager.net/amer/".to_owned(),
    );

    assert!(role_bot.is_none());
    assert!(same_account.is_none());
}

#[test]
fn incoming_message_extracts_authenticated_endpoint_and_context() {
    let message = incoming_message(
        activity(json!({
            "type": "message",
            "id": "activity-1",
            "serviceUrl": "https://smba.trafficmanager.net/amer/",
            "channelId": "msteams",
            "from": { "id": "29:user" },
            "recipient": { "id": "28:bot" },
            "conversation": { "id": "conv-1", "tenantId": "tenant-1" },
            "channelData": {
                "team": { "id": "team-1" },
                "channel": { "id": "channel-1" }
            },
            "text": "<at>Lite Agent</at> do the thing"
        })),
        "https://smba.trafficmanager.net/amer/".to_owned(),
    )
    .unwrap();

    assert_eq!(message.service_url, "https://smba.trafficmanager.net/amer/");
    assert_eq!(message.conversation_id, "conv-1");
    assert_eq!(message.tenant_id.as_deref(), Some("tenant-1"));
    assert_eq!(message.team_id.as_deref(), Some("team-1"));
    assert_eq!(message.teams_channel_id.as_deref(), Some("channel-1"));
    assert_eq!(message.prompt, "do the thing");
}

#[test]
fn agent_runtime_defaults_to_claude_managed_agents() {
    assert_eq!(agent_runtime(&agent(json!({}))), CLAUDE_MANAGED_AGENTS);
    assert_eq!(
        agent_runtime(&agent(json!({ "runtime": " cursor " }))),
        "cursor"
    );
}

fn activity(value: Value) -> TeamsActivity {
    serde_json::from_value(value).unwrap()
}

fn agent(config: Value) -> ManagedAgentRow {
    ManagedAgentRow {
        id: "agent-1".to_owned(),
        name: "Agent".to_owned(),
        model: "openai/gpt-5-mini".to_owned(),
        system: "system".to_owned(),
        tools: json!([]),
        cadence: None,
        interval_seconds: None,
        session_id: "session-1".to_owned(),
        loop_id: None,
        created_at: 0,
        prompt: None,
        cron: None,
        timezone: "UTC".to_owned(),
        vault_keys: json!([]),
        setup_commands: json!([]),
        max_runtime_minutes: 30,
        on_failure: "pause".to_owned(),
        config,
        owner_id: None,
        status: "active".to_owned(),
        description: None,
        harness: CLAUDE_MANAGED_AGENTS.to_owned(),
        skill_ids: json!([]),
        rule_ids: json!([]),
    }
}
