use std::collections::HashSet;

use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, QueryBuilder};

use crate::{
    db::managed_agents::{id, now_ms},
    errors::GatewayError,
};

use super::schema::RuntimeEventRow;

pub async fn append(
    pool: &PgPool,
    session_id: &str,
    event: Value,
) -> Result<RuntimeEventRow, GatewayError> {
    let mut rows = append_many(pool, session_id, vec![event]).await?;
    rows.pop().ok_or_else(|| {
        GatewayError::InvalidConfig("runtime event append returned no row".to_owned())
    })
}

pub async fn append_many(
    pool: &PgPool,
    session_id: &str,
    events: Vec<Value>,
) -> Result<Vec<RuntimeEventRow>, GatewayError> {
    if events.is_empty() {
        return Ok(Vec::new());
    }

    let mut seen = HashSet::new();
    let mut prepared = Vec::with_capacity(events.len());
    for event in events.into_iter().rev() {
        let key = event_key(&event);
        if seen.insert(key.clone()) {
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            prepared.push((key, event_type, event));
        }
    }
    prepared.reverse();

    let mut tx = pool.begin().await.map_err(GatewayError::Database)?;
    sqlx::query(
        r#"
        SELECT id
        FROM "LiteLLM_ManagedAgentSessionsTable"
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(session_id)
    .fetch_one(tx.as_mut())
    .await
    .map_err(GatewayError::Database)?;

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

    let created_at = now_ms();
    let mut rows = Vec::with_capacity(prepared.len());
    for (chunk_index, chunk) in prepared.chunks(1_000).enumerate() {
        let offset = chunk_index * 1_000;
        let mut query = QueryBuilder::<Postgres>::new(
            r#"INSERT INTO "LiteLLM_ManagedAgentRuntimeEventsTable"
              (id, session_id, seq, event_key, event_type, event_json, created_at) "#,
        );
        query.push_values(
            chunk.iter().enumerate(),
            |mut row, (index, (event_key, event_type, event))| {
                row.push_bind(id("rtevt"))
                    .push_bind(session_id)
                    .push_bind(next_seq + (offset + index) as i32)
                    .push_bind(event_key)
                    .push_bind(event_type)
                    .push_bind(event)
                    .push_bind(created_at);
            },
        );
        query.push(
            r#" ON CONFLICT (session_id, event_key) DO UPDATE SET
              event_type = EXCLUDED.event_type,
              event_json = EXCLUDED.event_json
            RETURNING *"#,
        );
        rows.extend(
            query
                .build_query_as::<RuntimeEventRow>()
                .fetch_all(tx.as_mut())
                .await
                .map_err(GatewayError::Database)?,
        );
    }

    sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentSessionsTable"
        SET updated_at = $2
        WHERE id = $1
        "#,
    )
    .bind(session_id)
    .bind(created_at)
    .execute(tx.as_mut())
    .await
    .map_err(GatewayError::Database)?;

    tx.commit().await.map_err(GatewayError::Database)?;
    rows.sort_by_key(|row| row.seq);
    Ok(rows)
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
