use serde_json::Value;
use sqlx::PgPool;

use crate::{
    db::managed_agents::{id, now_ms},
    errors::GatewayError,
};

use super::schema::SessionRow;

#[derive(Debug)]
pub struct CreateRuntimeSession<'a> {
    pub runtime: &'a str,
    pub agent_id: &'a str,
    pub title: &'a str,
    pub timezone: Option<&'a str>,
    pub runtime_agent_ref_id: Option<&'a str>,
    pub environment: Value,
    pub provider_session_id: Option<&'a str>,
    pub provider_run_id: Option<&'a str>,
}

pub async fn create(
    pool: &PgPool,
    harness: &str,
    agent_id: Option<&str>,
    title: &str,
    timezone: Option<&str>,
) -> Result<SessionRow, GatewayError> {
    let session_id = id("ses");
    sqlx::query_as::<_, SessionRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentSessionsTable"
          (id, harness, agent_id, title, created_at, tz)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
        "#,
    )
    .bind(session_id)
    .bind(harness)
    .bind(agent_id)
    .bind(title)
    .bind(now_ms())
    .bind(timezone)
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn create_runtime(
    pool: &PgPool,
    input: CreateRuntimeSession<'_>,
) -> Result<SessionRow, GatewayError> {
    let session_id = id("ses");
    sqlx::query_as::<_, SessionRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentSessionsTable" (
          id, harness, agent_id, title, created_at, tz, runtime,
          runtime_agent_ref_id, environment_json, provider_session_id,
          provider_run_id, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $2, $7, $8, $9, $10, 'starting')
        RETURNING *
        "#,
    )
    .bind(session_id)
    .bind(input.runtime)
    .bind(input.agent_id)
    .bind(input.title)
    .bind(now_ms())
    .bind(input.timezone)
    .bind(input.runtime_agent_ref_id)
    .bind(input.environment)
    .bind(input.provider_session_id)
    .bind(input.provider_run_id)
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn set_runtime_refs(
    pool: &PgPool,
    session_id: &str,
    runtime_agent_ref_id: &str,
    provider_session_id: Option<&str>,
    provider_run_id: Option<&str>,
    status: &str,
) -> Result<SessionRow, GatewayError> {
    sqlx::query_as::<_, SessionRow>(
        r#"
        UPDATE "LiteLLM_ManagedAgentSessionsTable"
        SET runtime_agent_ref_id = $2,
            provider_session_id = COALESCE($3, provider_session_id),
            provider_run_id = COALESCE($4, provider_run_id),
            status = $5,
            updated_at = $6
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(session_id)
    .bind(runtime_agent_ref_id)
    .bind(provider_session_id)
    .bind(provider_run_id)
    .bind(status)
    .bind(now_ms())
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn set_provider_run(
    pool: &PgPool,
    session_id: &str,
    provider_run_id: &str,
    status: &str,
) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentSessionsTable"
        SET provider_run_id = $2,
            status = $3,
            updated_at = $4
        WHERE id = $1
        "#,
    )
    .bind(session_id)
    .bind(provider_run_id)
    .bind(status)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

pub async fn set_status(pool: &PgPool, session_id: &str, status: &str) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentSessionsTable"
        SET status = $2,
            updated_at = $3
        WHERE id = $1
        "#,
    )
    .bind(session_id)
    .bind(status)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

pub async fn list(pool: &PgPool) -> Result<Vec<SessionRow>, GatewayError> {
    sqlx::query_as::<_, SessionRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentSessionsTable"
        ORDER BY COALESCE(updated_at, created_at) DESC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn get(pool: &PgPool, session_id: &str) -> Result<Option<SessionRow>, GatewayError> {
    sqlx::query_as::<_, SessionRow>(
        r#"SELECT * FROM "LiteLLM_ManagedAgentSessionsTable" WHERE id = $1"#,
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn delete(pool: &PgPool, session_id: &str) -> Result<bool, GatewayError> {
    let result = sqlx::query(r#"DELETE FROM "LiteLLM_ManagedAgentSessionsTable" WHERE id = $1"#)
        .bind(session_id)
        .execute(pool)
        .await
        .map_err(GatewayError::Database)?;
    Ok(result.rows_affected() > 0)
}

pub async fn touch(pool: &PgPool, session_id: &str) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentSessionsTable"
        SET updated_at = $2
        WHERE id = $1
        "#,
    )
    .bind(session_id)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}
