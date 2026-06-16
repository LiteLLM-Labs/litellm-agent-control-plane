use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    channels::secrets::load_secret,
    db::managed_agents::registry::{
        self,
        schema::{ManagedAgentRow, UpdateManagedAgent},
    },
    errors::GatewayError,
};

use super::types::GoogleChatAgentConfig;

#[allow(dead_code)]
pub(crate) const DEFAULT_VAULT_USER: &str = "default";

pub(crate) async fn load_agent(
    pool: &PgPool,
    agent_id: &str,
) -> Result<ManagedAgentRow, GatewayError> {
    registry::repository::get(pool, agent_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("agent not found".to_owned()))
}

pub(crate) fn google_chat_config(
    agent: &ManagedAgentRow,
) -> Result<GoogleChatAgentConfig, GatewayError> {
    serde_json::from_value(
        agent
            .config
            .get("google_chat")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )
    .map_err(GatewayError::InvalidJson)
}

pub(crate) fn service_account_key_name(agent_id: &str, config: &GoogleChatAgentConfig) -> String {
    config
        .service_account_json_key
        .clone()
        .unwrap_or_else(|| format!("GOOGLE_CHAT_{agent_id}_SERVICE_ACCOUNT_JSON"))
}

pub(crate) async fn load_service_account_json(
    state: &crate::proxy::state::AppState,
    agent_id: &str,
    config: &GoogleChatAgentConfig,
) -> Result<String, GatewayError> {
    load_secret(state, &service_account_key_name(agent_id, config)).await
}

#[allow(dead_code)]
pub(crate) async fn update_google_chat_config(
    pool: &PgPool,
    agent: &ManagedAgentRow,
    patch: Value,
) -> Result<(), GatewayError> {
    let config = patched_google_chat_config(&agent.config, patch);
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

#[allow(dead_code)]
fn patched_google_chat_config(config: &Value, patch: Value) -> Value {
    let mut root = config.as_object().cloned().unwrap_or_default();
    let mut google_chat = root
        .get("google_chat")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(patch) = patch.as_object() {
        for (key, value) in patch {
            google_chat.insert(key.clone(), value.clone());
        }
    }
    root.insert("google_chat".to_owned(), Value::Object(google_chat));
    Value::Object(root)
}
