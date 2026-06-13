use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::errors::GatewayError;

use super::types::{TeamsChannelAccount, TeamsConversationAccount};

const DEFAULT_TENANT: &str = "botframework.com";
const TOKEN_SCOPE: &str = "https://api.botframework.com/.default";
pub(crate) const MAX_TEXT_CHARS: usize = 24_000;

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct ActivityResponse {
    id: Option<String>,
}

pub(crate) async fn access_token(
    client: &Client,
    app_id: &str,
    app_password: &str,
    tenant_id: Option<&str>,
) -> Result<String, GatewayError> {
    let tenant = tenant_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_TENANT);
    let url = format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token");
    let response: TokenResponse = client
        .post(url)
        .form(&[
            ("grant_type", "client_credentials"),
            ("client_id", app_id),
            ("client_secret", app_password),
            ("scope", TOKEN_SCOPE),
        ])
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)?;
    Ok(response.access_token)
}

pub(crate) struct SendActivityParams<'a> {
    pub client: &'a Client,
    pub service_url: &'a str,
    pub token: &'a str,
    pub conversation_id: &'a str,
    pub reply_to_id: &'a str,
    pub text: &'a str,
    pub tenant_id: Option<&'a str>,
    pub from: Option<&'a TeamsChannelAccount>,
    pub recipient: Option<&'a TeamsChannelAccount>,
}

pub(crate) async fn post_reply(params: SendActivityParams<'_>) -> Result<String, GatewayError> {
    let response: ActivityResponse = params
        .client
        .post(format!(
            "{}/v3/conversations/{}/activities/{}",
            params.service_url.trim_end_matches('/'),
            params.conversation_id,
            params.reply_to_id
        ))
        .bearer_auth(params.token)
        .json(&activity_body(
            params.text,
            params.conversation_id,
            params.tenant_id,
            params.from,
            params.recipient,
            Some(params.reply_to_id),
        ))
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)?;
    response
        .id
        .ok_or_else(|| GatewayError::SandboxError("teams reply omitted activity id".to_owned()))
}

pub(crate) async fn update_activity(
    params: SendActivityParams<'_>,
    activity_id: &str,
) -> Result<(), GatewayError> {
    params
        .client
        .put(format!(
            "{}/v3/conversations/{}/activities/{}",
            params.service_url.trim_end_matches('/'),
            params.conversation_id,
            activity_id
        ))
        .bearer_auth(params.token)
        .json(&activity_body(
            params.text,
            params.conversation_id,
            params.tenant_id,
            params.from,
            params.recipient,
            Some(params.reply_to_id),
        ))
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .error_for_status()
        .map_err(GatewayError::Upstream)?;
    Ok(())
}

fn activity_body(
    text: &str,
    conversation_id: &str,
    tenant_id: Option<&str>,
    from: Option<&TeamsChannelAccount>,
    recipient: Option<&TeamsChannelAccount>,
    reply_to_id: Option<&str>,
) -> Value {
    let mut body = json!({
        "type": "message",
        "text": truncate(text),
        "textFormat": "markdown",
    });
    if let Some(from) = from {
        body["from"] = json!(from);
    }
    if let Some(recipient) = recipient {
        body["recipient"] = json!(recipient);
    }
    body["conversation"] = json!(TeamsConversationAccount {
        id: Some(conversation_id.to_owned()),
        name: None,
        conversation_type: None,
        tenant_id: tenant_id.map(str::to_owned),
    });
    if let Some(reply_to_id) = reply_to_id {
        body["replyToId"] = reply_to_id.into();
    }
    body
}

fn truncate(text: &str) -> String {
    text.chars().take(MAX_TEXT_CHARS).collect()
}
