use sqlx::PgPool;

use crate::{
    db::managed_agents::{id, now_ms},
    errors::GatewayError,
};

use super::schema::{RuntimeRefRow, UpsertRuntimeRef};

pub async fn get_by_id(pool: &PgPool, id: &str) -> Result<Option<RuntimeRefRow>, GatewayError> {
    sqlx::query_as::<_, RuntimeRefRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentRuntimeRefsTable"
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn get(
    pool: &PgPool,
    agent_id: &str,
    runtime: &str,
) -> Result<Option<RuntimeRefRow>, GatewayError> {
    sqlx::query_as::<_, RuntimeRefRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentRuntimeRefsTable"
        WHERE agent_id = $1 AND runtime = $2
        "#,
    )
    .bind(agent_id)
    .bind(runtime)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn upsert(
    pool: &PgPool,
    agent_id: &str,
    runtime: &str,
    input: UpsertRuntimeRef,
) -> Result<RuntimeRefRow, GatewayError> {
    let now = now_ms();
    sqlx::query_as::<_, RuntimeRefRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentRuntimeRefsTable" (
          id, agent_id, runtime, runtime_agent_id, provider_session_id,
          provider_run_id, provider_url, metadata, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
        ON CONFLICT (agent_id, runtime) DO UPDATE SET
          runtime_agent_id = EXCLUDED.runtime_agent_id,
          provider_session_id = EXCLUDED.provider_session_id,
          provider_run_id = EXCLUDED.provider_run_id,
          provider_url = EXCLUDED.provider_url,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
        RETURNING *
        "#,
    )
    .bind(id("rtref"))
    .bind(agent_id)
    .bind(runtime)
    .bind(input.runtime_agent_id)
    .bind(input.provider_session_id)
    .bind(input.provider_run_id)
    .bind(input.provider_url)
    .bind(input.metadata)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}
