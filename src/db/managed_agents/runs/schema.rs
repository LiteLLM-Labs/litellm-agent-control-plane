use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct AgentRunRow {
    pub id: String,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub config_overrides: Value,
    pub sandbox_id: Option<String>,
    pub logs: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateRun {
    pub session_id: Option<String>,
    pub config_overrides: Option<Value>,
    pub prompt: Option<String>,
}
