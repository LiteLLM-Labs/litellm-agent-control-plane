use serde_json::json;
use sqlx::PgPool;

use crate::{
    db::managed_agents::{id, now_ms},
    errors::GatewayError,
};

use super::schema::{AgentRunRow, CreateRun};

pub async fn create(
    pool: &PgPool,
    agent_id: &str,
    session_id: String,
    input: CreateRun,
) -> Result<AgentRunRow, GatewayError> {
    sqlx::query_as::<_, AgentRunRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentRunsTable"
          (id, agent_id, session_id, status, started_at, config_overrides)
        VALUES ($1, $2, $3, 'starting', $4, $5)
        RETURNING *
        "#,
    )
    .bind(id("run"))
    .bind(agent_id)
    .bind(input.session_id.unwrap_or(session_id))
    .bind(now_ms())
    .bind(input.config_overrides.unwrap_or_else(|| json!({})))
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn list(
    pool: &PgPool,
    agent_id: &str,
    limit: i64,
) -> Result<Vec<AgentRunRow>, GatewayError> {
    sqlx::query_as::<_, AgentRunRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentRunsTable"
        WHERE agent_id = $1
        ORDER BY started_at DESC
        LIMIT $2
        "#,
    )
    .bind(agent_id)
    .bind(limit.clamp(1, 100))
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn set_running(
    pool: &PgPool,
    run_id: &str,
    sandbox_id: Option<&str>,
) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentRunsTable"
        SET status = 'running',
            sandbox_id = COALESCE($2, sandbox_id)
        WHERE id = $1
        "#,
    )
    .bind(run_id)
    .bind(sandbox_id)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

pub async fn complete(pool: &PgPool, run_id: &str) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentRunsTable"
        SET status = 'completed',
            finished_at = $2
        WHERE id = $1
        "#,
    )
    .bind(run_id)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

pub async fn fail(pool: &PgPool, run_id: &str, error: &str) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentRunsTable"
        SET status = 'failed',
            finished_at = $2,
            error = $3
        WHERE id = $1
        "#,
    )
    .bind(run_id)
    .bind(now_ms())
    .bind(error)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

pub async fn append_logs(pool: &PgPool, run_id: &str, logs: &str) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentRunsTable"
        SET logs = logs || $2
        WHERE id = $1
        "#,
    )
    .bind(run_id)
    .bind(logs)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

pub async fn get(
    pool: &PgPool,
    agent_id: &str,
    run_id: &str,
) -> Result<Option<AgentRunRow>, GatewayError> {
    sqlx::query_as::<_, AgentRunRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentRunsTable"
        WHERE agent_id = $1 AND id = $2
        "#,
    )
    .bind(agent_id)
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}
