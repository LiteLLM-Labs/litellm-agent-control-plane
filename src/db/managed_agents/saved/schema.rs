use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct SavedAgentRow {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    pub base_agent: String,
    pub created_at: i64,
}
