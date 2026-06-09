use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct MemoryRow {
    pub id: String,
    pub agent_id: String,
    pub key: String,
    pub value: String,
    pub always_on: i32,
    pub created_at: i64,
    pub updated_at: i64,
}
