use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct WebhookAgentConfig {
    pub secret_key: Option<String>,
    pub prompt_json_pointer: Option<String>,
    pub title_json_pointer: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct WebhookAcceptedResponse {
    pub status: &'static str,
    pub agent_id: String,
    pub session_id: String,
    pub request_id: String,
}
