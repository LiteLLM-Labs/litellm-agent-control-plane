use serde::Serialize;
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct SpendLogRow {
    pub request_id: String,
    pub call_type: String,
    pub api_key: String,
    pub spend: f64,
    pub total_tokens: i32,
    pub prompt_tokens: i32,
    pub completion_tokens: i32,
    #[sqlx(rename = "startTime")]
    pub start_time: String,
    #[sqlx(rename = "endTime")]
    pub end_time: String,
    pub request_duration_ms: Option<i32>,
    pub model: String,
    pub model_id: Option<String>,
    pub model_group: Option<String>,
    pub custom_llm_provider: Option<String>,
    pub api_base: Option<String>,
    pub user: Option<String>,
    pub metadata: Option<Value>,
    pub cache_hit: Option<String>,
    pub cache_key: Option<String>,
    pub request_tags: Option<Value>,
    pub end_user: Option<String>,
    pub requester_ip_address: Option<String>,
    pub messages: Option<Value>,
    pub response: Option<Value>,
    pub session_id: Option<String>,
    pub status: Option<String>,
}
