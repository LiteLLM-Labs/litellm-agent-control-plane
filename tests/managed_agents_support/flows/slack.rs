use axum::http::StatusCode;
use litellm_rust::db::managed_agents::slack as slack_db;
use serde_json::json;
use sqlx::PgPool;

use super::{
    super::{request_json, request_raw, AppFixture},
    claude_runtime::save_anthropic_credentials,
    slack_helpers::{
        assert_legacy_prefixed_slack_secret, assert_slack_api_call_count, assert_slack_api_called,
        now_seconds, percent_encode, provider_id_for, signed_json_request, signed_request,
        slack_api_call_count,
    },
    slack_url_verification::{assert_url_verification, assert_url_verification_without_secret},
};

pub async fn exercise_slack(fixture: &AppFixture, agent_id: &str) {
    let _anthropic = save_anthropic_credentials(fixture).await;
    save_slack_secrets(fixture, agent_id).await;
    configure_agent_slack(fixture, agent_id).await;
    assert_oauth_callback(fixture, agent_id).await;
    assert_url_verification(fixture, agent_id).await;
    assert_url_verification_without_secret(fixture, agent_id).await;
    assert_legacy_prefixed_slack_secret(fixture, agent_id).await;
    assert_thread_session_race(fixture, agent_id).await;
    let reaction_baseline = slack_api_call_count(fixture, "/reactions.add").await;
    let post_baseline = slack_api_call_count(fixture, "/chat.postMessage").await;
    let session_id = send_app_mention(fixture, agent_id).await;
    assert_runtime_session(fixture, &session_id).await;
    assert_slack_api_call_count(fixture, "/reactions.add", reaction_baseline + 1).await;
    assert_slack_api_call_count(fixture, "/chat.postMessage", post_baseline + 1).await;
    assert_slack_api_called(fixture, "/chat.update").await;
    send_channel_thread_reply(fixture, agent_id).await;
    // Wait for the thread-reply response before capturing the baseline in
    // enable_and_assert_slack_messages so the count is deterministic.
    assert_slack_api_call_count(fixture, "/chat.postMessage", post_baseline + 2).await;
    super::slack_mcp::enable_and_assert_slack_messages(fixture, agent_id).await;
    assert_slack_api_call_count(fixture, "/reactions.add", reaction_baseline + 2).await;
    assert_slack_api_call_count(fixture, "/chat.postMessage", post_baseline + 4).await;
    assert_interactivity_accepts_approval(fixture, agent_id).await;
}

async fn assert_runtime_session(fixture: &AppFixture, session_id: &str) {
    let runtime: String = sqlx::query_scalar(
        r#"
        SELECT runtime
        FROM "LiteLLM_ManagedAgentSessionsTable"
        WHERE id = $1
        "#,
    )
    .bind(session_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(runtime, "claude_managed_agents");
}

pub(super) async fn save_slack_secrets(fixture: &AppFixture, agent_id: &str) {
    for (key, value) in [
        (format!("SLACK_{agent_id}_SIGNING_SECRET"), "slack-secret"),
        (format!("SLACK_{agent_id}_CLIENT_SECRET"), "client-secret"),
        (format!("SLACK_{agent_id}_BOT_TOKEN"), "xoxb-test"),
    ] {
        request_json(
            fixture.app.clone(),
            "POST",
            "/api/vault/default",
            Some(json!({ "key": key, "value": value })),
        )
        .await;
    }
    let vault = request_json(fixture.app.clone(), "GET", "/api/vault/default", None).await;
    let keys = vault["keys"].as_array().unwrap();
    assert!(keys
        .iter()
        .any(|entry| entry["key"] == format!("SLACK_{agent_id}_SIGNING_SECRET")));
}

async fn configure_agent_slack(fixture: &AppFixture, agent_id: &str) {
    request_json(
        fixture.app.clone(),
        "PATCH",
        &format!("/api/agents/{agent_id}"),
        Some(json!({
            "config": {
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

async fn assert_oauth_callback(fixture: &AppFixture, agent_id: &str) {
    let state = request_json(
        fixture.app.clone(),
        "POST",
        &format!("/api/agents/{agent_id}/slack/oauth-state"),
        None,
    )
    .await["state"]
        .as_str()
        .unwrap()
        .to_owned();
    request_raw(
        fixture.app.clone(),
        "GET",
        &format!(
            "/host-oauth-callback/{}?state={state}&code=oauth-code",
            provider_id_for(agent_id)
        ),
        None,
        "application/json",
        StatusCode::SEE_OTHER,
    )
    .await;
    let agent = request_json(
        fixture.app.clone(),
        "GET",
        &format!("/api/agents/{agent_id}"),
        None,
    )
    .await;
    assert_eq!(agent["config"]["slack"]["status"], "connected");
    assert_eq!(agent["config"]["slack"]["bot_user_id"], "B123");
    assert_slack_api_called(fixture, "/oauth.v2.access").await;
}

async fn send_app_mention(fixture: &AppFixture, agent_id: &str) -> String {
    let body = json!({
        "type": "event_callback",
        "team_id": "T123",
        "api_app_id": "A123",
        "event_time": now_seconds(),
        "event": {
            "type": "app_mention",
            "user": "U123",
            "text": "<@B123> say hello",
            "ts": "1712345678.000100",
            "channel": "C123",
            "event_ts": "1712345678.000100"
        }
    })
    .to_string();
    signed_json_request(
        fixture,
        &format!("/api/agents/{agent_id}/slack/events"),
        body.clone(),
        StatusCode::OK,
    )
    .await;
    signed_json_request(
        fixture,
        &format!("/api/agents/{agent_id}/slack/events"),
        body,
        StatusCode::OK,
    )
    .await;
    wait_for_slack_session(&fixture.pool, agent_id, "C123", "1712345678.000100").await
}

async fn send_channel_thread_reply(fixture: &AppFixture, agent_id: &str) {
    let body = json!({
        "type": "event_callback",
        "team_id": "T123",
        "api_app_id": "A123",
        "event_id": "Ev-thread-reply",
        "event_time": now_seconds(),
        "event": {
            "type": "message",
            "channel_type": "channel",
            "user": "U123",
            "text": "and then what?",
            "ts": "1712345678.000200",
            "thread_ts": "1712345678.000100",
            "channel": "C123",
            "event_ts": "1712345678.000200"
        }
    })
    .to_string();
    signed_json_request(
        fixture,
        &format!("/api/agents/{agent_id}/slack/events"),
        body,
        StatusCode::OK,
    )
    .await;
}

async fn assert_thread_session_race(fixture: &AppFixture, agent_id: &str) {
    let (left, right) = tokio::join!(
        slack_db::repository::ensure_thread_session(
            &fixture.pool,
            agent_id,
            "claude-code",
            "UTC",
            "C-race",
            "1712345678.999999",
        ),
        slack_db::repository::ensure_thread_session(
            &fixture.pool,
            agent_id,
            "claude-code",
            "UTC",
            "C-race",
            "1712345678.999999",
        )
    );
    let left = left.unwrap();
    let right = right.unwrap();
    assert_eq!(left.session_id, right.session_id);
}

async fn assert_interactivity_accepts_approval(fixture: &AppFixture, agent_id: &str) {
    sqlx::query(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentInboxItemsTable"
          (id, kind, title, status, created_at)
        VALUES ('slack_appr_1', 'approval', 'approve slack action', 'pending', 10)
        "#,
    )
    .execute(&fixture.pool)
    .await
    .unwrap();

    let payload = json!({
        "type": "block_actions",
        "actions": [{
            "action_id": "lap_approval_accept",
            "value": "slack_appr_1"
        }]
    })
    .to_string();
    let body = format!("payload={}", percent_encode(&payload));
    signed_request(
        fixture,
        &format!("/api/agents/{agent_id}/slack/interactivity"),
        body,
        "application/x-www-form-urlencoded",
        StatusCode::OK,
    )
    .await;
    let status: String = sqlx::query_scalar(
        r#"
        SELECT status
        FROM "LiteLLM_ManagedAgentInboxItemsTable"
        WHERE id = 'slack_appr_1'
        "#,
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(status, "accepted");
}

async fn wait_for_slack_session(
    pool: &PgPool,
    agent_id: &str,
    channel_id: &str,
    thread_ts: &str,
) -> String {
    for _ in 0..20 {
        if let Some(session_id) = sqlx::query_scalar::<_, String>(
            r#"
            SELECT session_id
            FROM "LiteLLM_ManagedAgentSlackThreadSessionsTable"
            WHERE agent_id = $1 AND channel_id = $2 AND thread_ts = $3
            "#,
        )
        .bind(agent_id)
        .bind(channel_id)
        .bind(thread_ts)
        .fetch_optional(pool)
        .await
        .unwrap()
        {
            return session_id;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("slack thread session was not created");
}
