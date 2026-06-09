use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::{
    db::managed_agents::{id, now_ms, sessions},
    errors::GatewayError,
};

use super::schema::RuntimeEventRow;

pub async fn append(
    pool: &PgPool,
    session_id: &str,
    event: Value,
) -> Result<RuntimeEventRow, GatewayError> {
    let mut tx = pool.begin().await.map_err(GatewayError::Database)?;
    let event_key = event_key(&event);
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let next_seq: i32 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(MAX(seq), 0) + 1
        FROM "LiteLLM_ManagedAgentRuntimeEventsTable"
        WHERE session_id = $1
        "#,
    )
    .bind(session_id)
    .fetch_one(tx.as_mut())
    .await
    .map_err(GatewayError::Database)?;

    let row = sqlx::query_as::<_, RuntimeEventRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentRuntimeEventsTable"
          (id, session_id, seq, event_key, event_type, event_json, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (session_id, event_key) DO UPDATE SET
          event_json = EXCLUDED.event_json
        RETURNING *
        "#,
    )
    .bind(id("rtevt"))
    .bind(session_id)
    .bind(next_seq)
    .bind(event_key)
    .bind(event_type)
    .bind(event)
    .bind(now_ms())
    .fetch_one(tx.as_mut())
    .await
    .map_err(GatewayError::Database)?;

    tx.commit().await.map_err(GatewayError::Database)?;
    sessions::repository::touch(pool, session_id).await?;
    Ok(row)
}

pub async fn list(pool: &PgPool, session_id: &str) -> Result<Vec<Value>, GatewayError> {
    let rows = sqlx::query_as::<_, RuntimeEventRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentRuntimeEventsTable"
        WHERE session_id = $1
        ORDER BY seq ASC
        "#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(rows.into_iter().map(|row| row.event_json).collect())
}

fn event_key(event: &Value) -> String {
    if let Some(id) = event.get("id").and_then(Value::as_str) {
        return format!("id:{id}");
    }
    let mut hash = Sha256::new();
    hash.update(event.to_string().as_bytes());
    format!("sha256:{:x}", hash.finalize())
}
