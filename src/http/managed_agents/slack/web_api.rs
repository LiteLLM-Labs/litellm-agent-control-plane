use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use crate::errors::GatewayError;

pub(super) const MAX_TEXT_CHARS: usize = 3_900;

#[derive(Debug, Deserialize)]
pub struct SlackOAuthAccessResponse {
    pub ok: bool,
    pub access_token: Option<String>,
    pub bot_user_id: Option<String>,
    pub team: Option<SlackTeam>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SlackTeam {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SlackMessageResponse {
    ok: bool,
    ts: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SlackOkResponse {
    ok: bool,
    error: Option<String>,
}

pub struct UpsertMessageParams<'a> {
    pub client: &'a Client,
    pub api_base_url: &'a str,
    pub bot_token: &'a str,
    pub channel: &'a str,
    pub thread_ts: &'a str,
    pub ts: Option<&'a str>,
    pub text: &'a str,
    pub username: Option<&'a str>,
}

pub async fn post_message_as(
    client: &Client,
    api_base_url: &str,
    bot_token: &str,
    channel: &str,
    thread_ts: &str,
    text: &str,
    username: Option<&str>,
) -> Result<String, GatewayError> {
    let response = post_message_raw(
        client,
        api_base_url,
        bot_token,
        channel,
        thread_ts,
        text,
        username,
    )
    .await?;
    if response.ok {
        return response.ts.ok_or_else(|| {
            GatewayError::SandboxError("slack chat.postMessage omitted ts".to_owned())
        });
    }
    if username.is_some() && response.error.as_deref() == Some("missing_scope") {
        let fallback = post_message_raw(
            client,
            api_base_url,
            bot_token,
            channel,
            thread_ts,
            text,
            None,
        )
        .await?;
        return match fallback.ok {
            true => fallback.ts.ok_or_else(|| {
                GatewayError::SandboxError("slack chat.postMessage omitted ts".to_owned())
            }),
            false => Err(slack_api_error("chat.postMessage", fallback.error)),
        };
    }
    Err(slack_api_error("chat.postMessage", response.error))
}

async fn post_message_raw(
    client: &Client,
    api_base_url: &str,
    bot_token: &str,
    channel: &str,
    thread_ts: &str,
    text: &str,
    username: Option<&str>,
) -> Result<SlackMessageResponse, GatewayError> {
    let mut body = json!({
        "channel": channel,
        "thread_ts": thread_ts,
        "text": truncate(text),
    });
    if let Some(username) = username.map(str::trim).filter(|value| !value.is_empty()) {
        body["username"] = username.into();
    }
    let response: SlackMessageResponse = client
        .post(method_url(api_base_url, "chat.postMessage"))
        .bearer_auth(bot_token)
        .json(&body)
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)?;
    Ok(response)
}

pub async fn update_message(
    client: &Client,
    api_base_url: &str,
    bot_token: &str,
    channel: &str,
    ts: &str,
    text: &str,
) -> Result<(), GatewayError> {
    let response: SlackOkResponse = client
        .post(method_url(api_base_url, "chat.update"))
        .bearer_auth(bot_token)
        .json(&json!({
            "channel": channel,
            "ts": ts,
            "text": truncate(text),
        }))
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)?;
    if response.ok {
        Ok(())
    } else {
        Err(slack_api_error("chat.update", response.error))
    }
}

pub async fn upsert_message_as(params: UpsertMessageParams<'_>) -> Result<String, GatewayError> {
    if let Some(ts) = params.ts {
        update_message(
            params.client,
            params.api_base_url,
            params.bot_token,
            params.channel,
            ts,
            params.text,
        )
        .await?;
        return Ok(ts.to_owned());
    }
    post_message_as(
        params.client,
        params.api_base_url,
        params.bot_token,
        params.channel,
        params.thread_ts,
        params.text,
        params.username,
    )
    .await
}

pub async fn add_reaction(
    client: &Client,
    api_base_url: &str,
    bot_token: &str,
    channel: &str,
    timestamp: &str,
    name: &str,
) -> Result<(), GatewayError> {
    let response: SlackOkResponse = client
        .post(method_url(api_base_url, "reactions.add"))
        .bearer_auth(bot_token)
        .json(&json!({
            "channel": channel,
            "timestamp": timestamp,
            "name": name,
        }))
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)?;
    if response.ok {
        Ok(())
    } else {
        Err(slack_api_error("reactions.add", response.error))
    }
}

pub async fn oauth_access(
    client: &Client,
    api_base_url: &str,
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<SlackOAuthAccessResponse, GatewayError> {
    client
        .post(method_url(api_base_url, "oauth.v2.access"))
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)
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
    text.chars().take(MAX_TEXT_CHARS).collect()
}
