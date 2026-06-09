use serde::{Deserialize, Serialize};

pub(crate) const DEFAULT_VAULT_USER: &str = "default";

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct SlackAgentConfig {
    pub app_name: Option<String>,
    pub app_id: Option<String>,
    pub client_id: Option<String>,
    pub provider_id: Option<String>,
    pub status: Option<String>,
    pub app_config_token_key: Option<String>,
    pub client_secret_key: Option<String>,
    pub signing_secret_key: Option<String>,
    pub bot_token_key: Option<String>,
    pub slack_team_name: Option<String>,
    pub bot_user_id: Option<String>,
    pub oauth_error: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct SlackIncomingMessage {
    pub channel: String,
    pub thread_ts: String,
    pub reply_thread_ts: String,
    pub team_id: Option<String>,
    pub user_id: Option<String>,
    pub prompt: String,
    pub requires_existing_thread: bool,
}

#[derive(Debug, Deserialize)]
pub struct OAuthCallbackQuery {
    pub(super) code: Option<String>,
    pub(super) state: Option<String>,
    pub(super) error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SlackOAuthStateResponse {
    pub(super) state: String,
}
