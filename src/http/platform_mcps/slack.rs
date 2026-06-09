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

fn optional_str<'a>(arguments: &'a Value, field: &str) -> Option<&'a str> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
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
