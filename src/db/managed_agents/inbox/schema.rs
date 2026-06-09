use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct InboxItemRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub session_id: Option<String>,
    pub agent: Option<String>,
    pub body: Option<String>,
    pub args_json: Option<String>,
    pub status: String,
    pub feedback: Option<String>,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}
