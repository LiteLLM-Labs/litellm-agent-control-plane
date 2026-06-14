use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    errors::GatewayError,
    http::managed_agents::slack::{
        config::{bot_token_key, load_secret, slack_config},
        dm_api,
    },
    proxy::state::AppState,
};

use super::required_str;

pub async fn send_message(
    state: &AppState,
    pool: &PgPool,
    agent_id: &str,
    arguments: Value,
) -> Result<Value, GatewayError> {
    let agent = crate::db::managed_agents::registry::repository::get(pool, agent_id)
        .await?
        .ok_or_else(|| GatewayError::UnknownAgent(agent_id.to_owned()))?;
    let config = slack_config(&agent)?;
    if config.status.as_deref() != Some("connected") {
        return Err(GatewayError::InvalidConfig(
            "Slack must be connected before the agent can send messages".to_owned(),
        ));
    }
    let bot_token = load_secret(state, &bot_token_key(agent_id, &config)).await?;
    let text = required_str(&arguments, "text")?;
    if let Some(channel_id) = optional_str(&arguments, "channel_id") {
        let ts = dm_api::post_direct_message(
            &state.http,
            &state.config.slack.api_base_url,
            &bot_token,
            channel_id,
            text,
        )
        .await?;
        return Ok(json!({ "channel_id": channel_id, "ts": ts }));
    }
    let user_id = user_id(state, &bot_token, &arguments).await?;
    let channel_id = dm_api::open_dm(
        &state.http,
        &state.config.slack.api_base_url,
        &bot_token,
        &user_id,
    )
    .await?;
    let ts = dm_api::post_direct_message(
        &state.http,
        &state.config.slack.api_base_url,
        &bot_token,
        &channel_id,
        text,
    )
    .await?;
    Ok(json!({
        "user_id": user_id,
        "channel_id": channel_id,
        "ts": ts
    }))
}

pub async fn create_channel(
    state: &AppState,
    pool: &PgPool,
    agent_id: &str,
    arguments: Value,
) -> Result<Value, GatewayError> {
    let agent = crate::db::managed_agents::registry::repository::get(pool, agent_id)
        .await?
        .ok_or_else(|| GatewayError::UnknownAgent(agent_id.to_owned()))?;
    let config = slack_config(&agent)?;
    if config.status.as_deref() != Some("connected") {
        return Err(GatewayError::InvalidConfig(
            "Slack must be connected before the agent can create channels".to_owned(),
        ));
    }
    let bot_token = load_secret(state, &bot_token_key(agent_id, &config)).await?;
    let name = required_str(&arguments, "name")?;
    let is_private = arguments
        .get("is_private")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let user_ids = invite_user_ids(state, &bot_token, &arguments).await?;
    let channel = dm_api::create_channel(
        &state.http,
        &state.config.slack.api_base_url,
        &bot_token,
        name,
        is_private,
    )
    .await?;
    let invite_error = match dm_api::invite_users(
        &state.http,
        &state.config.slack.api_base_url,
        &bot_token,
        &channel.id,
        &user_ids,
    )
    .await
    {
        Ok(()) => None,
        Err(error) => Some(error.to_string()),
    };
    let invited_user_ids = if invite_error.is_some() {
        Vec::new()
    } else {
        user_ids
    };
    Ok(json!({
        "channel_id": channel.id,
        "name": channel.name,
        "is_private": is_private,
        "invited_user_ids": invited_user_ids,
        "invite_error": invite_error
    }))
}

fn optional_str<'a>(arguments: &'a Value, field: &str) -> Option<&'a str> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn optional_string_array(arguments: &Value, field: &str) -> Vec<String> {
    arguments
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

async fn user_id(
    state: &AppState,
    bot_token: &str,
    arguments: &Value,
) -> Result<String, GatewayError> {
    if let Some(user_id) = optional_str(arguments, "user_id") {
        return Ok(user_id.to_owned());
    }
    let email = required_str(arguments, "email")?;
    dm_api::user_id_by_email(
        &state.http,
        &state.config.slack.api_base_url,
        bot_token,
        email,
    )
    .await
}

async fn invite_user_ids(
    state: &AppState,
    bot_token: &str,
    arguments: &Value,
) -> Result<Vec<String>, GatewayError> {
    let mut user_ids = optional_string_array(arguments, "user_ids");
    for email in optional_string_array(arguments, "emails") {
        user_ids.push(
            dm_api::user_id_by_email(
                &state.http,
                &state.config.slack.api_base_url,
                bot_token,
                &email,
            )
            .await?,
        );
    }
    Ok(dedupe(user_ids))
}

fn dedupe(values: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}
