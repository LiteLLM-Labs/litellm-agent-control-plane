use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct HarnessRow {
    pub id: String,
    pub alias: String,
    pub api_spec: String,
    pub api_base: String,
    pub created_at: i64,
    pub updated_at: i64,
}
