use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct SlackThreadSessionRow {
    pub agent_id: String,
    pub channel_id: String,
    pub thread_ts: String,
    pub session_id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct SlackAgentBindingRow {
    pub id: String,
    pub platform_agent_id: String,
    pub agent_id: String,
    pub team_id: Option<String>,
    pub channel_id: String,
    pub thread_ts: Option<String>,
    pub dm_user_id: Option<String>,
    pub created_by: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct SlackPendingInstallRow {
    pub state: String,
    pub platform_agent_id: String,
    pub agent_id: String,
    pub team_id: Option<String>,
    pub channel_id: String,
    pub thread_ts: Option<String>,
    pub dm_user_id: Option<String>,
    pub requested_by: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub used_at: Option<i64>,
}
