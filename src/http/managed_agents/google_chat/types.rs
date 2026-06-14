use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct GoogleChatAgentConfig {
    pub app_name: Option<String>,
    pub status: Option<String>,
    pub auth_audience: Option<String>,
    pub project_number: Option<String>,
    pub service_account_json_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GoogleChatEvent {
    #[serde(rename = "type")]
    pub event_type: Option<String>,
    pub message: Option<GoogleChatMessage>,
    pub space: Option<GoogleChatSpace>,
    pub thread: Option<GoogleChatThread>,
    pub user: Option<GoogleChatUser>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GoogleChatMessage {
    pub name: Option<String>,
    pub text: Option<String>,
    pub sender: Option<GoogleChatUser>,
    pub thread: Option<GoogleChatThread>,
    pub space: Option<GoogleChatSpace>,
    pub annotations: Option<Vec<GoogleChatAnnotation>>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GoogleChatSpace {
    pub name: Option<String>,
    #[serde(rename = "spaceType", alias = "type")]
    pub space_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GoogleChatUser {
    pub name: Option<String>,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "type")]
    pub user_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GoogleChatThread {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GoogleChatAnnotation {
    #[serde(rename = "type")]
    pub annotation_type: Option<String>,
    #[serde(rename = "userMention")]
    pub user_mention: Option<GoogleChatUserMention>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GoogleChatUserMention {
    pub user: Option<GoogleChatUser>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum GoogleChatMessageMode {
    DirectMessage,
    ChannelMention,
    ChannelMessage,
}

impl GoogleChatMessageMode {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::DirectMessage => "direct_message",
            Self::ChannelMention => "channel_mention",
            Self::ChannelMessage => "channel_message",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct GoogleChatIncomingMessage {
    pub message_name: String,
    pub space_name: String,
    pub thread_name: Option<String>,
    pub conversation_key: String,
    pub user_name: Option<String>,
    pub prompt: String,
    pub mode: GoogleChatMessageMode,
}
