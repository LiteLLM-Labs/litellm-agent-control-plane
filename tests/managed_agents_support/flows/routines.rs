use serde_json::json;

use super::super::{read_events_until_completed, request_json, AppFixture};

pub async fn exercise_routines(fixture: &AppFixture, agent_id: &str) {
    let routine_id = create_routine(fixture, agent_id).await;
    assert_listed(fixture, agent_id, &routine_id).await;
    update_routine(fixture, &routine_id).await;
    trigger_routine(fixture, agent_id, &routine_id).await;
    delete_routine(fixture, &routine_id).await;
}

async fn create_routine(fixture: &AppFixture, agent_id: &str) -> String {
    let created = request_json(
        fixture.app.clone(),
        "POST",
        "/api/routines",
        Some(json!({
            "agent_id": agent_id,
            "name": "Daily deploy watch",
            "prompt": "check deploy status",
            "cron": "0 9 * * 1-5",
            "timezone": "America/Los_Angeles"
        })),
    )
    .await;
    assert_eq!(created["agent_id"], agent_id);
    assert_eq!(created["status"], "active");
    created["id"].as_str().unwrap().to_owned()
}

async fn assert_listed(fixture: &AppFixture, agent_id: &str, routine_id: &str) {
    let listed = request_json(fixture.app.clone(), "GET", "/api/routines", None).await;
    assert_eq!(listed["routines"].as_array().unwrap().len(), 1);
    assert_eq!(listed["routines"][0]["id"], routine_id);

    let agent_routines = request_json(
        fixture.app.clone(),
        "GET",
        &format!("/api/routines?agent_id={agent_id}"),
        None,
    )
    .await;
    assert_eq!(agent_routines["routines"].as_array().unwrap().len(), 1);
}

async fn update_routine(fixture: &AppFixture, routine_id: &str) {
    let updated = request_json(
        fixture.app.clone(),
        "PATCH",
        &format!("/api/routines/{routine_id}"),
        Some(json!({ "status": "paused", "cron": "0 10 * * 1-5" })),
    )
    .await;
    assert_eq!(updated["status"], "paused");
    assert_eq!(updated["cron"], "0 10 * * 1-5");
}

async fn trigger_routine(fixture: &AppFixture, agent_id: &str, routine_id: &str) {
    let run = request_json(
        fixture.app.clone(),
        "POST",
        &format!("/api/routines/{routine_id}/trigger"),
        None,
    )
    .await;
    let run_id = run["run_id"].as_str().unwrap().to_owned();
    assert_eq!(run["agent_id"], agent_id);

    let events = read_events_until_completed(fixture.app.clone(), "/event", &run_id).await;
    assert!(events.contains("\"type\":\"session.idle\""));

    let after_trigger = request_json(fixture.app.clone(), "GET", "/api/routines", None).await;
    assert_eq!(after_trigger["routines"][0]["last_run_id"], run_id);
    assert!(
        after_trigger["routines"][0]["last_run_at"]
            .as_i64()
            .unwrap()
            > 0
    );
}

async fn delete_routine(fixture: &AppFixture, routine_id: &str) {
    request_json(
        fixture.app.clone(),
        "DELETE",
        &format!("/api/routines/{routine_id}"),
        None,
    )
    .await;
    let empty = request_json(fixture.app.clone(), "GET", "/api/routines", None).await;
    assert_eq!(empty["routines"].as_array().unwrap().len(), 0);
}
