use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use crate::errors::GatewayError;

#[derive(Debug, Deserialize)]
struct SlackMessageResponse {
    ok: bool,
    ts: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SlackOpenConversationResponse {
    ok: bool,
    channel: Option<SlackChannel>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SlackChannel {
    id: String,
}

#[derive(Debug, Deserialize)]
struct SlackLookupUserResponse {
    ok: bool,
    user: Option<SlackUser>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SlackUser {
    id: String,
}

pub async fn open_dm(
    client: &Client,
    api_base_url: &str,
    bot_token: &str,
    user_id: &str,
) -> Result<String, GatewayError> {
    let response: SlackOpenConversationResponse = client
        .post(method_url(api_base_url, "conversations.open"))
        .bearer_auth(bot_token)
        .json(&json!({ "users": user_id }))
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)?;
    if response.ok {
        response.channel.map(|channel| channel.id).ok_or_else(|| {
            GatewayError::SandboxError("slack conversations.open omitted channel".to_owned())
        })
    } else {
        Err(slack_api_error("conversations.open", response.error))
    }
}

pub async fn post_direct_message(
    client: &Client,
    api_base_url: &str,
    bot_token: &str,
    channel: &str,
    text: &str,
) -> Result<String, GatewayError> {
    let response: SlackMessageResponse = client
        .post(method_url(api_base_url, "chat.postMessage"))
        .bearer_auth(bot_token)
        .json(&json!({
            "channel": channel,
            "text": truncate(text),
        }))
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)?;
    if response.ok {
        response.ts.ok_or_else(|| {
            GatewayError::SandboxError("slack chat.postMessage omitted ts".to_owned())
        })
    } else {
        Err(slack_api_error("chat.postMessage", response.error))
    }
}

pub async fn user_id_by_email(
    client: &Client,
    api_base_url: &str,
    bot_token: &str,
    email: &str,
) -> Result<String, GatewayError> {
    let response: SlackLookupUserResponse = client
        .post(method_url(api_base_url, "users.lookupByEmail"))
        .bearer_auth(bot_token)
        .form(&[("email", email)])
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)?;
    if response.ok {
        response.user.map(|user| user.id).ok_or_else(|| {
            GatewayError::SandboxError("slack users.lookupByEmail omitted user".to_owned())
        })
    } else {
        Err(slack_api_error("users.lookupByEmail", response.error))
    }
}

fn method_url(api_base_url: &str, method: &str) -> String {
    format!("{}/{}", api_base_url.trim_end_matches('/'), method)
}

fn slack_api_error(method: &str, error: Option<String>) -> GatewayError {
    GatewayError::SandboxError(format!(
        "slack {method} failed: {}",
        error.unwrap_or_else(|| "unknown_error".to_owned())
    ))
}

fn truncate(text: &str) -> String {
    const MAX_CHARS: usize = 30_000;
    text.chars().take(MAX_CHARS).collect()
}
