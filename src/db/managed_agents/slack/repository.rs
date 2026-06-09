use sqlx::{PgPool, Postgres, Transaction};

use crate::{
    db::managed_agents::{id, now_ms},
    errors::GatewayError,
};

use super::schema::SlackThreadSessionRow;

pub async fn list(
    pool: &PgPool,
    agent_id: &str,
) -> Result<Vec<SlackThreadSessionRow>, GatewayError> {
    sqlx::query_as::<_, SlackThreadSessionRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentSlackThreadSessionsTable"
        WHERE agent_id = $1
        ORDER BY updated_at DESC
        "#,
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn get(
    pool: &PgPool,
    agent_id: &str,
    channel_id: &str,
    thread_ts: &str,
) -> Result<Option<SlackThreadSessionRow>, GatewayError> {
    sqlx::query_as::<_, SlackThreadSessionRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentSlackThreadSessionsTable"
        WHERE agent_id = $1 AND channel_id = $2 AND thread_ts = $3
        "#,
    )
    .bind(agent_id)
    .bind(channel_id)
    .bind(thread_ts)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn upsert(
    pool: &PgPool,
    agent_id: &str,
    channel_id: &str,
    thread_ts: &str,
    session_id: &str,
) -> Result<SlackThreadSessionRow, GatewayError> {
    let now = now_ms();
    sqlx::query_as::<_, SlackThreadSessionRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentSlackThreadSessionsTable"
          (agent_id, channel_id, thread_ts, session_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT (agent_id, channel_id, thread_ts) DO UPDATE SET
          session_id = EXCLUDED.session_id,
          updated_at = EXCLUDED.updated_at
        RETURNING *
        "#,
    )
    .bind(agent_id)
    .bind(channel_id)
    .bind(thread_ts)
    .bind(session_id)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn ensure_thread_session(
    pool: &PgPool,
    agent_id: &str,
    harness: &str,
    timezone: &str,
    channel_id: &str,
    thread_ts: &str,
) -> Result<SlackThreadSessionRow, GatewayError> {
    let mut tx = pool.begin().await.map_err(GatewayError::Database)?;
    lock_thread(&mut tx, agent_id, channel_id, thread_ts).await?;
    if let Some(row) = select_thread(&mut tx, agent_id, channel_id, thread_ts).await? {
        let row = update_thread_timestamp(&mut tx, row).await?;
        tx.commit().await.map_err(GatewayError::Database)?;
        return Ok(row);
    }
    let row =
        insert_thread_session(&mut tx, agent_id, harness, timezone, channel_id, thread_ts).await?;
    tx.commit().await.map_err(GatewayError::Database)?;
    Ok(row)
}

pub async fn record_event(
    pool: &PgPool,
    agent_id: &str,
    event_id: &str,
) -> Result<bool, GatewayError> {
    let result = sqlx::query(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentSlackEventsTable" (agent_id, event_id, created_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (agent_id, event_id) DO NOTHING
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(result.rows_affected() == 1)
}

pub async fn create_oauth_state(
    pool: &PgPool,
    agent_id: &str,
    provider_id: &str,
) -> Result<String, GatewayError> {
    let state = format!("slack_oauth_{}", uuid::Uuid::new_v4().simple());
    let now = now_ms();
    sqlx::query(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentSlackOAuthStatesTable"
          (state, agent_id, provider_id, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(&state)
    .bind(agent_id)
    .bind(provider_id)
    .bind(now)
    .bind(now + 10 * 60 * 1000)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(state)
}

pub async fn consume_oauth_state(
    pool: &PgPool,
    state: &str,
    provider_id: &str,
) -> Result<Option<String>, GatewayError> {
    sqlx::query_scalar(
        r#"
        UPDATE "LiteLLM_ManagedAgentSlackOAuthStatesTable"
        SET used_at = $3
        WHERE state = $1 AND provider_id = $2 AND used_at IS NULL AND expires_at >= $3
        RETURNING agent_id
        "#,
    )
    .bind(state)
    .bind(provider_id)
    .bind(now_ms())
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

async fn lock_thread(
    tx: &mut Transaction<'_, Postgres>,
    agent_id: &str,
    channel_id: &str,
    thread_ts: &str,
) -> Result<(), GatewayError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))")
        .bind(agent_id)
        .bind(format!("{channel_id}:{thread_ts}"))
        .execute(tx.as_mut())
        .await
        .map_err(GatewayError::Database)?;
    Ok(())
}

async fn select_thread(
    tx: &mut Transaction<'_, Postgres>,
    agent_id: &str,
    channel_id: &str,
    thread_ts: &str,
) -> Result<Option<SlackThreadSessionRow>, GatewayError> {
    sqlx::query_as::<_, SlackThreadSessionRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentSlackThreadSessionsTable"
        WHERE agent_id = $1 AND channel_id = $2 AND thread_ts = $3
        "#,
    )
    .bind(agent_id)
    .bind(channel_id)
    .bind(thread_ts)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(GatewayError::Database)
}

async fn update_thread_timestamp(
    tx: &mut Transaction<'_, Postgres>,
    row: SlackThreadSessionRow,
) -> Result<SlackThreadSessionRow, GatewayError> {
    sqlx::query_as::<_, SlackThreadSessionRow>(
        r#"
        UPDATE "LiteLLM_ManagedAgentSlackThreadSessionsTable"
        SET updated_at = $4
        WHERE agent_id = $1 AND channel_id = $2 AND thread_ts = $3
        RETURNING *
        "#,
    )
    .bind(row.agent_id)
    .bind(row.channel_id)
    .bind(row.thread_ts)
    .bind(now_ms())
    .fetch_one(tx.as_mut())
    .await
    .map_err(GatewayError::Database)
}

async fn insert_thread_session(
    tx: &mut Transaction<'_, Postgres>,
    agent_id: &str,
    harness: &str,
    timezone: &str,
    channel_id: &str,
    thread_ts: &str,
) -> Result<SlackThreadSessionRow, GatewayError> {
    let now = now_ms();
    let session_id = id("ses");
    let title = format!("Slack {channel_id} {thread_ts}");
    sqlx::query(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentSessionsTable"
          (id, harness, agent_id, title, created_at, tz)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(&session_id)
    .bind(harness)
    .bind(agent_id)
    .bind(title)
    .bind(now)
    .bind(timezone)
    .execute(tx.as_mut())
    .await
    .map_err(GatewayError::Database)?;
    insert_thread(tx, agent_id, channel_id, thread_ts, &session_id, now).await
}

async fn insert_thread(
    tx: &mut Transaction<'_, Postgres>,
    agent_id: &str,
    channel_id: &str,
    thread_ts: &str,
    session_id: &str,
    now: i64,
) -> Result<SlackThreadSessionRow, GatewayError> {
    sqlx::query_as::<_, SlackThreadSessionRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentSlackThreadSessionsTable"
          (agent_id, channel_id, thread_ts, session_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $5)
        RETURNING *
        "#,
    )
    .bind(agent_id)
    .bind(channel_id)
    .bind(thread_ts)
    .bind(session_id)
    .bind(now)
    .fetch_one(tx.as_mut())
    .await
    .map_err(GatewayError::Database)
}
