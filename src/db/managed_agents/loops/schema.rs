use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct LoopRow {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub interval_seconds: i32,
    pub max_iterations: Option<i32>,
    pub iteration_count: i32,
    pub next_run_at: i64,
    pub created_at: i64,
    pub cron_expr: Option<String>,
    pub tz: Option<String>,
}
