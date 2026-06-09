use serde::Serialize;
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct SessionRow {
    pub id: String,
    pub harness: String,
    pub agent_id: Option<String>,
    pub title: String,
    pub created_at: i64,
    pub updated_at: Option<i64>,
    pub sdk_session_id: Option<String>,
    pub tz: Option<String>,
    pub runtime: Option<String>,
    pub runtime_agent_ref_id: Option<String>,
    pub environment_json: Value,
    pub provider_session_id: Option<String>,
    pub provider_run_id: Option<String>,
    pub status: String,
}
