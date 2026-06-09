use sqlx::PgPool;

use crate::{
    db::managed_agents::{id, now_ms},
    errors::GatewayError,
};

use super::schema::MemoryRow;

pub async fn store(
    pool: &PgPool,
    agent_id: &str,
    key: String,
    value: String,
    always_on: Option<bool>,
) -> Result<MemoryRow, GatewayError> {
    if key.trim().is_empty() {
        return Err(GatewayError::InvalidJsonMessage(
            "key and value required".to_owned(),
        ));
    }

    let now = now_ms();
    let always_on = always_on
        .map(|value| if value { 1 } else { 0 })
        .unwrap_or(0);
    sqlx::query_as::<_, MemoryRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentMemoriesTable"
          (id, agent_id, key, value, always_on, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $6)
        ON CONFLICT (agent_id, key) DO UPDATE SET
          value = EXCLUDED.value,
          always_on = EXCLUDED.always_on,
          updated_at = EXCLUDED.updated_at
        RETURNING *
        "#,
    )
    .bind(id("mem"))
    .bind(agent_id)
    .bind(key)
    .bind(value)
    .bind(always_on)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn list(pool: &PgPool, agent_id: &str) -> Result<Vec<MemoryRow>, GatewayError> {
    sqlx::query_as::<_, MemoryRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentMemoriesTable"
        WHERE agent_id = $1
        ORDER BY updated_at DESC
        "#,
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn delete(pool: &PgPool, agent_id: &str, key: &str) -> Result<bool, GatewayError> {
    let result = sqlx::query(
        r#"
        DELETE FROM "LiteLLM_ManagedAgentMemoriesTable"
        WHERE agent_id = $1 AND key = $2
        "#,
    )
    .bind(agent_id)
    .bind(key)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;

    Ok(result.rows_affected() > 0)
}

pub async fn delete_all(pool: &PgPool, agent_id: &str) -> Result<(), GatewayError> {
    sqlx::query(r#"DELETE FROM "LiteLLM_ManagedAgentMemoriesTable" WHERE agent_id = $1"#)
        .bind(agent_id)
        .execute(pool)
        .await
        .map_err(GatewayError::Database)?;
    Ok(())
}
