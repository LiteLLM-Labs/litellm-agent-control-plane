use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ManagedAgentRow {
    pub id: String,
    pub name: String,
    pub model: String,
    pub system: String,
    pub tools: Value,
    pub cadence: Option<String>,
    pub interval_seconds: Option<i32>,
    pub session_id: String,
    pub loop_id: Option<String>,
    pub created_at: i64,
    pub prompt: Option<String>,
    pub cron: Option<String>,
    pub timezone: String,
    pub vault_keys: Value,
    pub setup_commands: Value,
    pub max_runtime_minutes: i32,
    pub on_failure: String,
    pub config: Value,
    pub owner_id: Option<String>,
    pub status: String,
    pub description: Option<String>,
    pub harness: String,
    pub skill_ids: Value,
    pub rule_ids: Value,
}

#[derive(Debug, Deserialize)]
pub struct CreateManagedAgent {
    pub name: String,
    pub owner_id: String,
    pub description: Option<String>,
    pub runtime: Option<String>,
    pub harness: Option<String>,
    pub prompt: Option<String>,
    pub tools: Option<Value>,
    pub schedule: Option<Schedule>,
    pub vault_keys: Option<Value>,
    pub setup_commands: Option<Value>,
    pub max_runtime_minutes: Option<i32>,
    pub on_failure: Option<String>,
    pub config: Option<Value>,
    pub model: Option<String>,
    pub system: Option<String>,
    pub skill_ids: Option<Value>,
    pub rule_ids: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct Schedule {
    pub cron: String,
    pub timezone: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateManagedAgent {
    pub name: Option<String>,
    pub model: Option<String>,
    pub runtime: Option<String>,
    pub system: Option<String>,
    pub prompt: Option<String>,
    pub cron: Option<String>,
    pub timezone: Option<String>,
    pub vault_keys: Option<Value>,
    pub setup_commands: Option<Value>,
    pub max_runtime_minutes: Option<i32>,
    pub on_failure: Option<String>,
    pub config: Option<Value>,
    pub owner_id: Option<String>,
    pub status: Option<String>,
    pub description: Option<String>,
    pub harness: Option<String>,
    pub skill_ids: Option<Value>,
    pub rule_ids: Option<Value>,
}
