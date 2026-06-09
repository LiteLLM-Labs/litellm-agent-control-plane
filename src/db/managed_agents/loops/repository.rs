use sqlx::PgPool;

use crate::errors::GatewayError;

use super::schema::LoopRow;

pub async fn get(pool: &PgPool, loop_id: &str) -> Result<Option<LoopRow>, GatewayError> {
    sqlx::query_as::<_, LoopRow>(r#"SELECT * FROM "LiteLLM_ManagedAgentLoopsTable" WHERE id = $1"#)
        .bind(loop_id)
        .fetch_optional(pool)
        .await
        .map_err(GatewayError::Database)
}
