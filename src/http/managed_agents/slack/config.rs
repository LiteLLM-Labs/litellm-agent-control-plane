use axum::http::HeaderMap;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::credentials,
    db::managed_agents::registry::{
        self,
        schema::{ManagedAgentRow, UpdateManagedAgent},
    },
    errors::GatewayError,
    proxy::{credential_crypto, state::AppState, vault},
};

use super::types::{SlackAgentConfig, DEFAULT_VAULT_USER};

pub(crate) async fn load_agent(
    pool: &PgPool,
    agent_id: &str,
) -> Result<ManagedAgentRow, GatewayError> {
    registry::repository::get(pool, agent_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("agent not found".to_owned()))
}

pub(crate) fn slack_config(agent: &ManagedAgentRow) -> Result<SlackAgentConfig, GatewayError> {
    serde_json::from_value(
        agent
            .config
            .get("slack")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )
    .map_err(GatewayError::InvalidJson)
}

pub(crate) async fn load_secret(state: &AppState, key: &str) -> Result<String, GatewayError> {
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    if let Some(value) = vault::load(pool, &state.config, DEFAULT_VAULT_USER, key).await? {
        return Ok(value);
    }
    let legacy_key = format!("vault:{DEFAULT_VAULT_USER}:{key}");
    if let Some(value) = load_legacy_secret(state, pool, &legacy_key).await? {
        return Ok(value);
    }
    Err(GatewayError::InvalidConfig(format!(
        "vault key is not configured: {key}"
    )))
}

async fn load_legacy_secret(
    state: &AppState,
    pool: &PgPool,
    key: &str,
) -> Result<Option<String>, GatewayError> {
    let Some(encrypted) = credentials::resolve_vault_key(pool, key, DEFAULT_VAULT_USER).await?
    else {
        return Ok(None);
    };
    let encryption_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    credential_crypto::decrypt_value(&encrypted, &encryption_key).map(Some)
}

pub(crate) fn signing_secret_key(agent_id: &str, config: &SlackAgentConfig) -> String {
    config
        .signing_secret_key
        .clone()
        .unwrap_or_else(|| format!("SLACK_{agent_id}_SIGNING_SECRET"))
}

pub(crate) fn client_secret_key(agent_id: &str, config: &SlackAgentConfig) -> String {
    config
        .client_secret_key
        .clone()
        .unwrap_or_else(|| format!("SLACK_{agent_id}_CLIENT_SECRET"))
}

pub(crate) fn app_config_token_key(agent_id: &str, config: &SlackAgentConfig) -> String {
    config
        .app_config_token_key
        .clone()
        .unwrap_or_else(|| format!("SLACK_{agent_id}_APP_CONFIG_TOKEN"))
}

pub(crate) fn bot_token_key(agent_id: &str, config: &SlackAgentConfig) -> String {
    config
        .bot_token_key
        .clone()
        .unwrap_or_else(|| format!("SLACK_{agent_id}_BOT_TOKEN"))
}

pub(crate) async fn update_slack_config(
    pool: &PgPool,
    agent: &ManagedAgentRow,
    patch: Value,
) -> Result<(), GatewayError> {
    let config = patched_slack_config(&agent.config, patch);
    registry::repository::update(
        pool,
        &agent.id,
        UpdateManagedAgent {
            name: None,
            model: None,
            runtime: None,
            system: None,
            prompt: None,
            cron: None,
            timezone: None,
            vault_keys: None,
            setup_commands: None,
            max_runtime_minutes: None,
            on_failure: None,
            config: Some(config),
            owner_id: None,
            status: None,
            description: None,
            harness: None,
            skill_ids: None,
            rule_ids: None,
        },
    )
    .await?;
    Ok(())
}

pub(crate) fn provider_id_for(agent_id: &str) -> String {
    let mut output = String::new();
    let mut last_dash = false;
    for ch in agent_id.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            output.push(ch);
            last_dash = false;
        } else if !last_dash {
            output.push('-');
            last_dash = true;
        }
    }
    output
}

pub(super) fn origin(headers: &HeaderMap) -> String {
    let proto = forwarded_header(headers, "x-forwarded-proto")
        .or_else(|| forwarded_header(headers, "x-forwarded-protocol"))
        .unwrap_or("http");
    let host = forwarded_header(headers, "x-forwarded-host")
        .or_else(|| forwarded_header(headers, "host"))
        .unwrap_or("localhost");
    format!("{proto}://{host}")
}

fn patched_slack_config(config: &Value, patch: Value) -> Value {
    let mut root = config.as_object().cloned().unwrap_or_default();
    let mut slack = root
        .get("slack")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(patch) = patch.as_object() {
        for (key, value) in patch {
            slack.insert(key.clone(), value.clone());
        }
    }
    root.insert("slack".to_owned(), Value::Object(slack));
    Value::Object(root)
}

fn forwarded_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}
