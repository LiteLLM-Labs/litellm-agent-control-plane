use sqlx::PgPool;

use crate::{db::managed_agents::now_ms, errors::GatewayError};

use super::schema::GoogleChatSpaceSessionRow;

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
    let existing = sqlx::query_as::<_, (String, i64)>(
        r#"
        SELECT status, updated_at
        FROM "LiteLLM_ManagedAgentGoogleChatEventsTable"
        WHERE agent_id = $1 AND event_id = $2
        FOR UPDATE
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(GatewayError::Database)?;

    let claim = match existing {
        None => {
            insert_event(tx.as_mut(), agent_id, event_id, now).await?;
            EventClaim::Claimed
        }
        Some((status, _)) if status == "completed" => EventClaim::Completed,
        Some((status, updated_at))
            if status == "processing" && now - updated_at < EVENT_PROCESSING_TIMEOUT_MS =>
        {
            EventClaim::InProgress
        }
        Some(_) => {
            update_event_status(tx.as_mut(), agent_id, event_id, "processing", now).await?;
            EventClaim::Claimed
        }
    };
    tx.commit().await.map_err(GatewayError::Database)?;
    Ok(claim)
}

async fn insert_event(
    conn: &mut sqlx::PgConnection,
    agent_id: &str,
    event_id: &str,
    now: i64,
) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentGoogleChatEventsTable"
          (agent_id, event_id, created_at, updated_at, status)
        VALUES ($1, $2, $3, $3, 'processing')
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .bind(now)
    .execute(conn)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
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
