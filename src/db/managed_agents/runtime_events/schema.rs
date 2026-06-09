use serde::Serialize;
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct RuntimeEventRow {
    pub id: String,
    pub session_id: String,
    pub seq: i32,
    pub event_key: String,
    pub event_type: String,
    pub event_json: Value,
    pub created_at: i64,
}
