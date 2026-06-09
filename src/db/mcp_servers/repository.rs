use sqlx::PgPool;

use crate::errors::GatewayError;

use super::schema::McpServerRow;
use super::write;
use super::SELECT_COLS;

pub use write::create;
pub use write::update;

pub async fn list(pool: &PgPool) -> Result<Vec<McpServerRow>, GatewayError> {
    let query =
        format!(r#"SELECT {SELECT_COLS} FROM "LiteLLM_MCPServerTable" ORDER BY created_at ASC"#);
    sqlx::query_as::<_, McpServerRow>(&query)
        .fetch_all(pool)
        .await
        .map_err(GatewayError::Database)
}

pub async fn list_public(pool: &PgPool) -> Result<Vec<McpServerRow>, GatewayError> {
    let query = format!(
        r#"SELECT {SELECT_COLS} FROM "LiteLLM_MCPServerTable"
           WHERE available_on_public_internet = TRUE AND approval_status = 'active'
           ORDER BY created_at ASC"#
    );
    sqlx::query_as::<_, McpServerRow>(&query)
        .fetch_all(pool)
        .await
        .map_err(GatewayError::Database)
}

pub async fn get(pool: &PgPool, server_id: &str) -> Result<Option<McpServerRow>, GatewayError> {
    let query =
        format!(r#"SELECT {SELECT_COLS} FROM "LiteLLM_MCPServerTable" WHERE server_id = $1"#);
    sqlx::query_as::<_, McpServerRow>(&query)
        .bind(server_id)
        .fetch_optional(pool)
        .await
        .map_err(GatewayError::Database)
}

pub async fn get_by_name(pool: &PgPool, name: &str) -> Result<Option<McpServerRow>, GatewayError> {
    // Match by server_id as well as name/alias: agents store the server id in
    // their mcp_servers entry, and the runtime builds the proxy URL from it.
    let query = format!(
        r#"SELECT {SELECT_COLS} FROM "LiteLLM_MCPServerTable"
           WHERE server_name = $1 OR alias = $1 OR server_id = $1
           LIMIT 1"#
    );
    sqlx::query_as::<_, McpServerRow>(&query)
        .bind(name)
        .fetch_optional(pool)
        .await
        .map_err(GatewayError::Database)
}

pub async fn delete(pool: &PgPool, server_id: &str) -> Result<bool, GatewayError> {
    let result = sqlx::query(r#"DELETE FROM "LiteLLM_MCPServerTable" WHERE server_id = $1"#)
        .bind(server_id)
        .execute(pool)
        .await
        .map_err(GatewayError::Database)?;

    Ok(result.rows_affected() > 0)
}
