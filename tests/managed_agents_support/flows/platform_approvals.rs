use litellm_rust::db::managed_agents::{messages, sessions as db_sessions};
use serde_json::{json, Value};

use crate::support::{request_json, AppFixture};

pub async fn assert_human_approval(fixture: &AppFixture, agent_id: &str) {
    assert_multiple_async_approvals(fixture, agent_id).await;
}

async fn assert_multiple_async_approvals(fixture: &AppFixture, agent_id: &str) {
    let session_id = seed_empty_session(fixture, agent_id, "approval session").await;
    let first =
        request_approval_call(fixture, agent_id, &session_id, 7, "approve deploy", "prod").await;
    let second =
        request_approval_call(fixture, agent_id, &session_id, 8, "reject deploy", "prod").await;

    let first_payload = content_json(&first);
    let second_payload = content_json(&second);
    assert_eq!(first_payload["status"], json!("pending"));
    assert_eq!(second_payload["status"], json!("pending"));
    let first_id = first_payload["approval_id"].as_str().unwrap();
    let second_id = second_payload["approval_id"].as_str().unwrap();
    assert_ne!(first_id, second_id);

    let approval_id = wait_for_approval_item(fixture, "approve deploy", &session_id).await;
    assert_eq!(approval_id, first_id);
    let rejection_id = wait_for_approval_item(fixture, "reject deploy", &session_id).await;
    assert_eq!(rejection_id, second_id);

    request_json(
        fixture.app.clone(),
        "POST",
        &format!("/api/approvals/{approval_id}/accept"),
        Some(json!({"arguments": {"environment": "staging"}})),
    )
    .await;
    assert_resume_message(fixture, &session_id, "Human approved approval").await;
    let checked = check_approval(fixture, agent_id, &approval_id).await;
    assert_eq!(checked["status"], json!("accepted"));
    assert_eq!(checked["arguments"]["environment"], json!("staging"));

    request_json(
        fixture.app.clone(),
        "POST",
        &format!("/api/approvals/{rejection_id}/reject"),
        Some(json!({"feedback": "Need a canary plan."})),
    )
    .await;
    assert_resume_message(fixture, &session_id, "Need a canary plan.").await;
    let checked = check_approval(fixture, agent_id, &rejection_id).await;
    assert_eq!(checked["status"], json!("rejected"));
    assert_eq!(checked["feedback"], json!("Need a canary plan."));
}

async fn request_approval_call(
    fixture: &AppFixture,
    agent_id: &str,
    session_id: &str,
    id: i32,
    title: &str,
    environment: &str,
) -> Value {
    request_json(
        fixture.app.clone(),
        "POST",
        &format!("/mcp/platform/{agent_id}?session_id={session_id}"),
        approval_call(id, title, environment),
    )
    .await
}

fn approval_call(id: i32, title: &str, environment: &str) -> Option<Value> {
    Some(json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": {
            "name": "request_human_approval",
            "arguments": {
                "title": title,
                "body": "Deploy production after smoke tests pass.",
                "session_id": "$SESSION_ID",
                "arguments": { "environment": environment }
            }
        }
    }))
}

async fn check_approval(fixture: &AppFixture, agent_id: &str, approval_id: &str) -> Value {
    let checked = request_json(
        fixture.app.clone(),
        "POST",
        &format!("/mcp/platform/{agent_id}"),
        Some(json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {
                "name": "check_human_approval",
                "arguments": { "approval_id": approval_id }
            }
        })),
    )
    .await;
    content_json(&checked)
}

async fn wait_for_approval_item(fixture: &AppFixture, title: &str, session_id: &str) -> String {
    for _ in 0..20 {
        let inbox = request_json(
            fixture.app.clone(),
            "GET",
            "/api/inbox?filter=attention",
            None,
        )
        .await;
        let found = inbox["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| is_target_approval(item, title));
        if let Some(item) = found {
            let args = serde_json::from_str::<Value>(item["args_json"].as_str().unwrap()).unwrap();
            assert_eq!(args["environment"], json!("prod"));
            assert_eq!(item["session_id"], json!(session_id));
            return item["id"].as_str().unwrap().to_owned();
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("approval item did not land in inbox");
}

async fn assert_resume_message(fixture: &AppFixture, session_id: &str, expected: &str) {
    for _ in 0..20 {
        let rows = messages::repository::list(&fixture.pool, session_id)
            .await
            .unwrap();
        if rows
            .iter()
            .any(|message| message.parts_json.contains(expected))
        {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("approval decision did not resume linked session");
}

async fn seed_empty_session(fixture: &AppFixture, agent_id: &str, title: &str) -> String {
    db_sessions::repository::create(&fixture.pool, "claude-code", Some(agent_id), title, None)
        .await
        .unwrap()
        .id
}

fn is_target_approval(item: &Value, title: &str) -> bool {
    item["kind"] == "approval" && item["status"] == "pending" && item["title"] == title
}

fn content_text(value: &Value) -> &str {
    value["result"]["content"][0]["text"].as_str().unwrap()
}

fn content_json(value: &Value) -> Value {
    serde_json::from_str(content_text(value)).unwrap()
}
