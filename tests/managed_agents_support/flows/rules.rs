use serde_json::json;

use super::super::{request_json, AppFixture};

pub async fn exercise_rules(fixture: &AppFixture, agent_id: &str) {
    let rule = request_json(
        fixture.app.clone(),
        "POST",
        "/api/rules",
        Some(json!({
            "name": "backend safety",
            "description": "Use repository helpers",
            "content": "Always use repository helpers before changing managed-agent DB code.",
            "owner_id": "user-1"
        })),
    )
    .await;
    let rule_id = rule["id"].as_str().unwrap();

    let rules = request_json(
        fixture.app.clone(),
        "GET",
        "/api/rules?owner_id=user-1",
        None,
    )
    .await;
    assert_eq!(rules["rules"].as_array().unwrap().len(), 1);

    let rule = request_json(
        fixture.app.clone(),
        "PATCH",
        &format!("/api/rules/{rule_id}"),
        Some(json!({"description": "always-on agent instruction"})),
    )
    .await;
    assert_eq!(rule["description"], "always-on agent instruction");

    let agent = request_json(
        fixture.app.clone(),
        "PATCH",
        &format!("/api/agents/{agent_id}"),
        Some(json!({"rule_ids": [rule_id]})),
    )
    .await;
    assert_eq!(agent["rule_ids"], json!([rule_id]));
}
