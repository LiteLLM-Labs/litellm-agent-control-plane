use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct AgentFileRow {
    pub agent_id: String,
    pub path: String,
    pub content: String,
    pub encoding: String,
    pub size_bytes: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct AgentFileMetadataRow {
    pub agent_id: String,
    pub path: String,
    pub encoding: String,
    pub size_bytes: i32,
    pub created_at: i64,
    pub updated_at: i64,
}
