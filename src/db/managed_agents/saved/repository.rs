use sqlx::PgPool;

use crate::errors::GatewayError;

use super::schema::SavedAgentRow;

pub async fn list(pool: &PgPool) -> Result<Vec<SavedAgentRow>, GatewayError> {
    sqlx::query_as::<_, SavedAgentRow>(
        r#"SELECT * FROM "LiteLLM_SavedAgentsTable" ORDER BY created_at ASC"#,
    )
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)
}
