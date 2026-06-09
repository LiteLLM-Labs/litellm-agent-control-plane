use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct SessionMessageRow {
    pub id: String,
    pub session_id: String,
    pub seq: i32,
    pub info_json: String,
    pub parts_json: String,
}
