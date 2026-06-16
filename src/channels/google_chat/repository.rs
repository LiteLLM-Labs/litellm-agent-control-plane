use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgPool};

use crate::{
    db::managed_agents::{messages, now_ms},
    errors::GatewayError,
};

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct GoogleChatSpaceSessionRow {
    pub agent_id: String,
    pub conversation_key: String,
    pub session_id: String,
    pub space_name: String,
    pub thread_name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

const EVENT_PROCESSING_TIMEOUT_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventClaim {
    Claimed,
    Completed,
    InProgress,
}

pub async fn get(
    pool: &PgPool,
    agent_id: &str,
    conversation_key: &str,
) -> Result<Option<GoogleChatSpaceSessionRow>, GatewayError> {
    sqlx::query_as::<_, GoogleChatSpaceSessionRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentGoogleChatSpaceSessionsTable"
        WHERE agent_id = $1 AND conversation_key = $2
        "#,
    )
    .bind(agent_id)
    .bind(conversation_key)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub struct UpsertSessionInput<'a> {
    pub agent_id: &'a str,
    pub conversation_key: &'a str,
    pub session_id: &'a str,
    pub space_name: &'a str,
    pub thread_name: Option<&'a str>,
}

pub async fn upsert(
    pool: &PgPool,
    input: UpsertSessionInput<'_>,
) -> Result<GoogleChatSpaceSessionRow, GatewayError> {
    let now = now_ms();
    sqlx::query_as::<_, GoogleChatSpaceSessionRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentGoogleChatSpaceSessionsTable"
          (agent_id, conversation_key, session_id, space_name, thread_name, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $6)
        ON CONFLICT (agent_id, conversation_key) DO UPDATE SET
          space_name = EXCLUDED.space_name,
          thread_name = EXCLUDED.thread_name,
          updated_at = EXCLUDED.updated_at
        RETURNING *
        "#,
    )
    .bind(input.agent_id)
    .bind(input.conversation_key)
    .bind(input.session_id)
    .bind(input.space_name)
    .bind(input.thread_name)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn claim_event(
    pool: &PgPool,
    agent_id: &str,
    event_id: &str,
) -> Result<EventClaim, GatewayError> {
    let mut tx = pool.begin().await.map_err(GatewayError::Database)?;
    let now = now_ms();
    let claim = if insert_event(tx.as_mut(), agent_id, event_id, now).await? {
        EventClaim::Claimed
    } else {
        claim_existing_event(tx.as_mut(), agent_id, event_id, now).await?
    };
    tx.commit().await.map_err(GatewayError::Database)?;
    Ok(claim)
}

async fn claim_existing_event(
    conn: &mut sqlx::PgConnection,
    agent_id: &str,
    event_id: &str,
    now: i64,
) -> Result<EventClaim, GatewayError> {
    let (status, updated_at) = sqlx::query_as::<_, (String, i64)>(
        r#"
        SELECT status, updated_at
        FROM "LiteLLM_ManagedAgentGoogleChatEventsTable"
        WHERE agent_id = $1 AND event_id = $2
        FOR UPDATE
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(GatewayError::Database)?;

    if status == "completed" {
        return Ok(EventClaim::Completed);
    }
    if status == "processing" && now - updated_at < EVENT_PROCESSING_TIMEOUT_MS {
        return Ok(EventClaim::InProgress);
    }
    update_event_status(conn, agent_id, event_id, "processing", now).await?;
    Ok(EventClaim::Claimed)
}

async fn insert_event(
    conn: &mut sqlx::PgConnection,
    agent_id: &str,
    event_id: &str,
    now: i64,
) -> Result<bool, GatewayError> {
    let result = sqlx::query(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentGoogleChatEventsTable"
          (agent_id, event_id, created_at, updated_at, status)
        VALUES ($1, $2, $3, $3, 'processing')
        ON CONFLICT (agent_id, event_id) DO NOTHING
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .bind(now)
    .execute(conn)
    .await
    .map_err(GatewayError::Database)?;
    Ok(result.rows_affected() == 1)
}

async fn update_event_status(
    conn: &mut sqlx::PgConnection,
    agent_id: &str,
    event_id: &str,
    status: &str,
    now: i64,
) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentGoogleChatEventsTable"
        SET status = $3, updated_at = $4
        WHERE agent_id = $1 AND event_id = $2
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .bind(status)
    .bind(now)
    .execute(conn)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

pub async fn heartbeat_event(
    pool: &PgPool,
    agent_id: &str,
    event_id: &str,
) -> Result<(), GatewayError> {
    let now = now_ms();
    sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentGoogleChatEventsTable"
        SET updated_at = $3
        WHERE agent_id = $1 AND event_id = $2 AND status = 'processing'
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .bind(now)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

pub async fn complete_event(
    pool: &PgPool,
    agent_id: &str,
    event_id: &str,
) -> Result<(), GatewayError> {
    let now = now_ms();
    sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentGoogleChatEventsTable"
        SET status = 'completed', updated_at = $3
        WHERE agent_id = $1 AND event_id = $2
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .bind(now)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

pub async fn fail_event(pool: &PgPool, agent_id: &str, event_id: &str) {
    let _ = sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentGoogleChatEventsTable"
        SET status = 'failed', updated_at = $3
        WHERE agent_id = $1 AND event_id = $2
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .bind(now_ms())
    .execute(pool)
    .await;
}

pub(crate) async fn last_message_seq(pool: &PgPool, session_id: &str) -> Result<i32, GatewayError> {
    let rows = messages::repository::list(pool, session_id).await?;
    Ok(rows.into_iter().map(|row| row.seq).max().unwrap_or(0))
}

pub(crate) async fn persisted_assistant_text_after(
    pool: &PgPool,
    session_id: &str,
    baseline_seq: i32,
) -> Result<Option<String>, GatewayError> {
    let rows = messages::repository::list(pool, session_id).await?;
    for row in rows.into_iter().rev() {
        if row.seq <= baseline_seq {
            continue;
        }
        let info: Value = serde_json::from_str(&row.info_json)?;
        if info.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if let Some(text) = text_parts(&row.parts_json)? {
            return Ok(Some(text));
        }
    }
    Ok(None)
}

fn text_parts(parts_json: &str) -> Result<Option<String>, GatewayError> {
    let parts: Value = serde_json::from_str(parts_json)?;
    let text = parts
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    Ok((!text.trim().is_empty()).then_some(text))
}
