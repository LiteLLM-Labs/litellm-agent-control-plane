use serde_json::{json, Value};

use crate::support::{request_json, AppFixture};

pub async fn assert_agent_skill_edit(fixture: &AppFixture, agent_id: &str) {
    let skill_id = seed_skill(fixture, "self-edit", "initial skill content").await;
    let unattached_skill_id = seed_skill(fixture, "other-skill", "do not edit").await;
    attach_skill(fixture, agent_id, &skill_id).await;

    assert_attached_skill_listed(fixture, agent_id, &skill_id, &unattached_skill_id).await;
    assert_attached_skill_updates(fixture, agent_id).await;
    assert_unattached_skill_denied(fixture, agent_id, &unattached_skill_id).await;

    attach_skills(fixture, agent_id, Vec::new()).await;
}

async fn assert_attached_skill_listed(
    fixture: &AppFixture,
    agent_id: &str,
    skill_id: &str,
    unattached_skill_id: &str,
) {
    let listed = rpc(
        fixture,
        agent_id,
        json!({
            "jsonrpc": "2.0",
            "id": 21,
            "method": "tools/call",
            "params": {
                "name": "edit_agent_skill",
                "arguments": { "action": "list" }
            }
        }),
    )
    .await;
    let list_content = content_text(&listed);
    assert!(list_content.contains(skill_id));
    assert!(list_content.contains("self-edit"));
    assert!(!list_content.contains(unattached_skill_id));
}

async fn assert_attached_skill_updates(fixture: &AppFixture, agent_id: &str) {
    let updated = rpc(
        fixture,
        agent_id,
        json!({
            "jsonrpc": "2.0",
            "id": 22,
            "method": "tools/call",
            "params": {
                "name": "edit_agent_skill",
                "arguments": {
                    "action": "update",
                    "content": "updated skill content",
                    "description": "edited by agent"
                }
            }
        }),
    )
    .await;
    let updated_content = content_text(&updated);
    assert!(updated_content.contains("updated skill content"));
    assert!(updated_content.contains("edited by agent"));
}

async fn assert_unattached_skill_denied(
    fixture: &AppFixture,
    agent_id: &str,
    unattached_skill_id: &str,
) {
    let denied = rpc(
        fixture,
        agent_id,
        json!({
            "jsonrpc": "2.0",
            "id": 23,
            "method": "tools/call",
            "params": {
                "name": "edit_agent_skill",
                "arguments": {
                    "action": "update",
                    "skill_id": unattached_skill_id,
                    "content": "should not land"
                }
            }
        }),
    )
    .await;
    assert!(content_text(&denied).contains("skill is not attached to this agent"));
}

async fn seed_skill(fixture: &AppFixture, name: &str, content: &str) -> String {
    request_json(
        fixture.app.clone(),
        "POST",
        "/api/skills",
        Some(json!({
            "name": name,
            "owner_id": "test",
            "content": content
        })),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn attach_skill(fixture: &AppFixture, agent_id: &str, skill_id: &str) {
    attach_skills(fixture, agent_id, vec![skill_id.to_owned()]).await;
}

async fn attach_skills(fixture: &AppFixture, agent_id: &str, skill_ids: Vec<String>) {
    request_json(
        fixture.app.clone(),
        "PATCH",
        &format!("/api/agents/{agent_id}"),
        Some(json!({ "skill_ids": skill_ids })),
    )
    .await;
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
