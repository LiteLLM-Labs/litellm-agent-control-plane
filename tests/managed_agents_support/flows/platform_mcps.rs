use litellm_rust::db::managed_agents::{messages, sessions as db_sessions};
use serde_json::{json, Value};

use crate::support::{read_events_until_completed, request_json, AppFixture};

pub async fn exercise_platform_mcps(fixture: &AppFixture, agent_id: &str) {
    assert_catalog(fixture).await;
    assert_tools_list(fixture, agent_id).await;
    assert_memory_write(fixture, agent_id).await;
    super::assert_agent_skill_edit(fixture, agent_id).await;
    assert_session_read(fixture, agent_id).await;
    assert_session_send(fixture, agent_id).await;
    assert_sub_agent_allowlist(fixture, agent_id).await;
    super::platform_approvals::assert_human_approval(fixture, agent_id).await;
    super::platform_factory::assert_agent_factory(fixture, agent_id).await;
}

async fn assert_catalog(fixture: &AppFixture) {
    let catalog = request_json(fixture.app.clone(), "GET", "/api/platform-mcps", None).await;
    let ids: Vec<_> = catalog["platform_mcps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|mcp| mcp["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![
            "read_platform_session",
            "send_platform_session_message",
            "agent_memory",
            "edit_agent_skill",
            "send_slack_message",
            "create_managed_agent",
            "connect_agent_to_slack",
            "list_slack_agent_bindings",
            "list_sub_agents",
            "run_sub_agent",
            "request_human_approval",
            "check_human_approval"
        ]
    );
}

async fn assert_tools_list(fixture: &AppFixture, agent_id: &str) {
    let tools = rpc(
        fixture,
        agent_id,
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
    )
    .await;
    assert_eq!(
        tools["result"]["tools"][0]["name"],
        json!("read_platform_session")
    );
}

async fn assert_memory_write(fixture: &AppFixture, agent_id: &str) {
    let saved = rpc(
        fixture,
        agent_id,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "agent_memory",
                "arguments": { "action": "set", "key": "platform", "value": "updated", "always_on": true }
            }
        }),
    )
    .await;
    assert!(content_text(&saved).contains("\"key\": \"platform\""));
}

async fn assert_session_read(fixture: &AppFixture, agent_id: &str) {
    let session_id = seed_session_message(fixture, agent_id).await;
    let read = rpc(
        fixture,
        agent_id,
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "read_platform_session",
                "arguments": { "session_id": session_id }
            }
        }),
    )
    .await;
    assert!(content_text(&read).contains("hello from session"));
}

async fn assert_session_send(fixture: &AppFixture, agent_id: &str) {
    let session_id = seed_empty_session(fixture, agent_id).await;
    let sent = rpc(
        fixture,
        agent_id,
        json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "send_platform_session_message",
                "arguments": { "session_id": session_id, "text": "continue from mcp" }
            }
        }),
    )
    .await;
    assert!(content_text(&sent).contains(&session_id));

    let events = read_events_until_completed(fixture.app.clone(), "/event", &session_id).await;
    assert!(events.contains("\"type\":\"session.idle\""));

    let read = rpc(
        fixture,
        agent_id,
        json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "read_platform_session",
                "arguments": { "session_id": session_id }
            }
        }),
    )
    .await;
    let content = content_text(&read);
    assert!(content.contains("continue from mcp"));
    assert!(content.contains("hello from managed agent"));
}

async fn assert_sub_agent_allowlist(fixture: &AppFixture, agent_id: &str) {
    let child_id = seed_child_agent(fixture).await;
    attach_child_agent(fixture, agent_id, &child_id).await;
    assert_list_sub_agents(fixture, agent_id, &child_id).await;
    let denied = rpc(
        fixture,
        agent_id,
        json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "run_sub_agent",
                "arguments": {
                    "agent_id": "agent_not_attached",
                    "prompt": "do focused work"
                }
            }
        }),
    )
    .await;
    let content = content_text(&denied);
    assert!(content.contains("sub-agent is not attached"));
    assert!(content.contains(&child_id));
    assert!(content.contains("Allowed Child"));
    attach_child_agents(fixture, agent_id, Vec::new()).await;
}

async fn seed_child_agent(fixture: &AppFixture) -> String {
    request_json(
        fixture.app.clone(),
        "POST",
        "/api/agents",
        Some(json!({
            "name": "Allowed Child",
            "owner_id": "test",
            "description": "Seeded child for platform MCP tests",
            "runtime": "claude_managed_agents",
            "model": "claude-sonnet-4-6",
            "system": "Do focused work.",
            "tools": [],
            "config": {
                "runtime": "claude_managed_agents",
                "tools": [],
                "mcp_servers": []
            }
        })),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn attach_child_agent(fixture: &AppFixture, agent_id: &str, child_id: &str) {
    attach_child_agents(fixture, agent_id, vec![child_id.to_owned()]).await;
}

async fn attach_child_agents(fixture: &AppFixture, agent_id: &str, child_ids: Vec<String>) {
    request_json(
        fixture.app.clone(),
        "PATCH",
        &format!("/api/agents/{agent_id}"),
        Some(json!({
            "config": {
                "runtime": "claude_managed_agents",
                "platform_mcp_ids": [],
                "sub_agents": child_ids
                    .into_iter()
                    .map(|agent_id| json!({ "agent_id": agent_id }))
                    .collect::<Vec<_>>()
            }
        })),
    )
    .await;
}

async fn assert_list_sub_agents(fixture: &AppFixture, agent_id: &str, child_id: &str) {
    let listed = rpc(
        fixture,
        agent_id,
        json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "list_sub_agents",
                "arguments": {}
            }
        }),
    )
    .await;
    let list_content = content_text(&listed);
    assert!(list_content.contains(child_id));
    assert!(list_content.contains("Allowed Child"));
}

async fn seed_session_message(fixture: &AppFixture, agent_id: &str) -> String {
    let session = db_sessions::repository::create(
        &fixture.pool,
        "claude-code",
        Some(agent_id),
        "platform mcp test",
        None,
    )
    .await
    .unwrap();
    messages::repository::append(
        &fixture.pool,
        &session.id,
        &json!({"role": "user"}).to_string(),
        &json!([{"type": "text", "text": "hello from session"}]).to_string(),
    )
    .await
    .unwrap();
    session.id
}

async fn seed_empty_session(fixture: &AppFixture, agent_id: &str) -> String {
    db_sessions::repository::create(
        &fixture.pool,
        "claude-code",
        Some(agent_id),
        "platform mcp send test",
        None,
    )
    .await
    .unwrap()
    .id
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
