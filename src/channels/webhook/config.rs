use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::managed_agents::registry::{self, schema::ManagedAgentRow},
    errors::GatewayError,
    proxy::state::AppState,
};

use super::types::WebhookAgentConfig;

pub(crate) const DEFAULT_SECRET_HEADER: &str = "x-litellm-webhook-secret";

pub(crate) async fn load_agent(
    pool: &PgPool,
    agent_id: &str,
) -> Result<ManagedAgentRow, GatewayError> {
    registry::repository::get(pool, agent_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("agent not found".to_owned()))
}

pub(crate) fn webhook_config(agent: &ManagedAgentRow) -> Result<WebhookAgentConfig, GatewayError> {
    serde_json::from_value(
        agent
            .config
            .get("webhook")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )
    .map_err(GatewayError::InvalidJson)
}

pub(crate) fn secret_key(agent_id: &str, config: &WebhookAgentConfig) -> String {
    config
        .secret_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("WEBHOOK_{agent_id}_SECRET"))
}

pub(crate) async fn load_webhook_secret(
    state: &AppState,
    agent_id: &str,
    config: &WebhookAgentConfig,
) -> Result<String, GatewayError> {
    crate::channels::secrets::load_secret(state, &secret_key(agent_id, config)).await
}

pub(crate) fn configured_header_name(config: &WebhookAgentConfig) -> &str {
    config
        .header_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_SECRET_HEADER)
}

pub(crate) fn agent_runtime(agent: &ManagedAgentRow) -> String {
    agent
        .config
        .get("runtime")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|runtime| !runtime.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| crate::sdk::agents::CLAUDE_MANAGED_AGENTS.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{secret_key, WebhookAgentConfig};

    #[test]
    fn blank_secret_key_uses_agent_default() {
        let config = WebhookAgentConfig {
            secret_key: Some(" ".to_owned()),
            ..Default::default()
        };

        assert_eq!(secret_key("agent-1", &config), "WEBHOOK_agent-1_SECRET");
    }
}
