use sqlx::PgPool;

use crate::{db::managed_agents, errors::GatewayError};

use super::schema::HarnessRow;

pub async fn list(pool: &PgPool) -> Result<Vec<HarnessRow>, GatewayError> {
    sqlx::query_as::<_, HarnessRow>(
        r#"SELECT id, alias, api_spec, api_base, created_at, updated_at
           FROM "LiteLLM_RuntimeHarnessTable"
           ORDER BY created_at ASC"#,
    )
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn get_by_alias(pool: &PgPool, alias: &str) -> Result<Option<HarnessRow>, GatewayError> {
    sqlx::query_as::<_, HarnessRow>(
        r#"SELECT id, alias, api_spec, api_base, created_at, updated_at
           FROM "LiteLLM_RuntimeHarnessTable"
           WHERE alias = $1"#,
    )
    .bind(alias)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn create(
    pool: &PgPool,
    alias: &str,
    api_spec: &str,
    api_base: &str,
) -> Result<HarnessRow, GatewayError> {
    let id = managed_agents::id("harness");
    let now = managed_agents::now_ms();
    sqlx::query_as::<_, HarnessRow>(
        r#"INSERT INTO "LiteLLM_RuntimeHarnessTable" (id, alias, api_spec, api_base, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, alias, api_spec, api_base, created_at, updated_at"#,
    )
    .bind(&id)
    .bind(alias)
    .bind(api_spec)
    .bind(api_base)
    .bind(now)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn update_api_base(
    pool: &PgPool,
    alias: &str,
    api_base: &str,
) -> Result<(), GatewayError> {
    let now = managed_agents::now_ms();
    sqlx::query(
        r#"UPDATE "LiteLLM_RuntimeHarnessTable"
           SET api_base = $1, updated_at = $2
           WHERE alias = $3"#,
    )
    .bind(api_base)
    .bind(now)
    .bind(alias)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

pub async fn delete(pool: &PgPool, alias: &str) -> Result<(), GatewayError> {
    sqlx::query(r#"DELETE FROM "LiteLLM_RuntimeHarnessTable" WHERE alias = $1"#)
        .bind(alias)
        .execute(pool)
        .await
        .map_err(GatewayError::Database)?;
    Ok(())
}
