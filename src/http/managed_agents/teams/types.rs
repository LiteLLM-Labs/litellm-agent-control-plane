use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct TeamsAgentConfig {
    pub app_name: Option<String>,
    pub app_id: Option<String>,
    pub tenant_id: Option<String>,
    pub status: Option<String>,
    pub app_password_key: Option<String>,
    pub oauth_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct TeamsActivity {
    #[serde(rename = "type")]
    pub activity_type: Option<String>,
    pub id: Option<String>,
    #[serde(rename = "serviceUrl")]
    pub service_url: Option<String>,
    #[serde(rename = "channelId")]
    pub channel_id: Option<String>,
    pub from: Option<TeamsChannelAccount>,
    pub recipient: Option<TeamsChannelAccount>,
    pub conversation: Option<TeamsConversationAccount>,
    pub text: Option<String>,
    #[serde(rename = "replyToId")]
    pub reply_to_id: Option<String>,
    #[serde(rename = "channelData")]
    pub channel_data: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct TeamsChannelAccount {
    pub id: Option<String>,
    pub name: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct TeamsConversationAccount {
    pub id: Option<String>,
    pub name: Option<String>,
    #[serde(rename = "conversationType")]
    pub conversation_type: Option<String>,
    #[serde(rename = "tenantId")]
    pub tenant_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct TeamsIncomingMessage {
    pub activity_id: String,
    pub service_url: String,
    pub conversation_id: String,
    pub tenant_id: Option<String>,
    pub team_id: Option<String>,
    pub teams_channel_id: Option<String>,
    pub user_id: Option<String>,
    pub prompt: String,
    pub from: Option<TeamsChannelAccount>,
    pub recipient: Option<TeamsChannelAccount>,
}
