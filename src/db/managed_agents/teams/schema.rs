use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct TeamsConversationSessionRow {
    pub agent_id: String,
    pub conversation_id: String,
    pub session_id: String,
    pub service_url: String,
    pub tenant_id: Option<String>,
    pub team_id: Option<String>,
    pub channel_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
