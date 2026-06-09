use sqlx::PgPool;

use crate::{db::managed_agents::now_ms, errors::GatewayError};

pub const MCP_PROXY_BASE_URL_KEY: &str = "mcp_proxy_base_url";

pub async fn get_mcp_proxy_base_url(pool: &PgPool) -> Result<Option<String>, GatewayError> {
    get_value(pool, MCP_PROXY_BASE_URL_KEY).await
}

pub async fn set_mcp_proxy_base_url(
    pool: &PgPool,
    value: Option<&str>,
    actor: &str,
) -> Result<Option<String>, GatewayError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        delete_value(pool, MCP_PROXY_BASE_URL_KEY).await?;
        return Ok(None);
    };

    upsert_value(pool, MCP_PROXY_BASE_URL_KEY, value, actor).await?;
    Ok(Some(value.to_owned()))
}

async fn get_value(pool: &PgPool, key: &str) -> Result<Option<String>, GatewayError> {
    sqlx::query_scalar::<_, String>(
        r#"
        SELECT value
        FROM "LiteLLM_GatewaySettingsTable"
        WHERE key = $1
        "#,
    )
    .bind(key)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

async fn upsert_value(
    pool: &PgPool,
    key: &str,
    value: &str,
    actor: &str,
) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        INSERT INTO "LiteLLM_GatewaySettingsTable"
          (key, value, updated_at, updated_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (key) DO UPDATE
        SET
          value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by
        "#,
    )
    .bind(key)
    .bind(value)
    .bind(now_ms())
    .bind(actor)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

async fn delete_value(pool: &PgPool, key: &str) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        DELETE FROM "LiteLLM_GatewaySettingsTable"
        WHERE key = $1
        "#,
    )
    .bind(key)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}
