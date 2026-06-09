use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct RuntimeRefRow {
    pub id: String,
    pub agent_id: String,
    pub runtime: String,
    pub runtime_agent_id: String,
    pub provider_session_id: Option<String>,
    pub provider_run_id: Option<String>,
    pub provider_url: Option<String>,
    pub metadata: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpsertRuntimeRef {
    pub runtime_agent_id: String,
    pub provider_session_id: Option<String>,
    pub provider_run_id: Option<String>,
    pub provider_url: Option<String>,
    pub metadata: Value,
}
