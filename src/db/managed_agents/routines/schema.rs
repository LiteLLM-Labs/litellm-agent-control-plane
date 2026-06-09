use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct RoutineRow {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub prompt: String,
    pub cron: String,
    pub timezone: String,
    pub status: String,
    pub last_run_id: Option<String>,
    pub last_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateRoutine {
    pub agent_id: String,
    pub name: String,
    pub prompt: Option<String>,
    pub cron: String,
    pub timezone: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRoutine {
    pub agent_id: Option<String>,
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub cron: Option<String>,
    pub timezone: Option<String>,
    pub status: Option<String>,
}
