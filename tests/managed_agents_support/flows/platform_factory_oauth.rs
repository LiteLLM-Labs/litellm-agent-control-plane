use axum::http::StatusCode;
use serde_json::Value;

use crate::support::{request_json, request_raw, AppFixture};

use super::slack_helpers::{assert_slack_api_called, provider_id_for};

pub(super) async fn assert_child_oauth_install(
    fixture: &AppFixture,
    platform_agent_id: &str,
    child_id: &str,
    connected: &Value,
) {
    let install_url = connected["install_url"].as_str().unwrap();
    let state = query_param(install_url, "state").unwrap();
    request_raw(
        fixture.app.clone(),
        "GET",
        &format!(
            "/host-oauth-callback/{}?state={state}&code=oauth-code",
            provider_id_for(child_id)
        ),
        None,
        "application/json",
        StatusCode::SEE_OTHER,
    )
    .await;
    let child = request_json(
        fixture.app.clone(),
        "GET",
        &format!("/api/agents/{child_id}"),
        None,
    )
    .await;
    assert_eq!(child["config"]["slack"]["status"], "connected");
    assert_eq!(
        child["config"]["slack"]["bot_token_key"],
        format!("SLACK_{child_id}_BOT_TOKEN")
    );
    assert_connected_binding(fixture, platform_agent_id, child_id).await;
    assert_slack_api_called(fixture, "/oauth.v2.access").await;
}

async fn assert_connected_binding(fixture: &AppFixture, platform_agent_id: &str, child_id: &str) {
    let binding: Option<(String, String, String)> = sqlx::query_as(
        r#"
        SELECT agent_id, channel_id, thread_ts
        FROM "LiteLLM_SlackAgentBindingsTable"
        WHERE platform_agent_id = $1 AND agent_id = $2 AND status = 'connected'
        "#,
    )
    .bind(platform_agent_id)
    .bind(child_id)
    .fetch_optional(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        binding,
        Some((
            child_id.to_owned(),
            "C-factory".to_owned(),
            "1712345679.000100".to_owned()
        ))
    );
}

fn query_param<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    url.split_once('?')?.1.split('&').find_map(|pair| {
        let (param_key, value) = pair.split_once('=')?;
        (param_key == key).then_some(value)
    })
}
