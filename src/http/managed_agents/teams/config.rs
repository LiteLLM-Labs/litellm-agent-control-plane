use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::managed_agents::registry::{
        self,
        schema::{ManagedAgentRow, UpdateManagedAgent},
    },
    errors::GatewayError,
    http::managed_agents::slack::config::load_secret,
};

use super::types::TeamsAgentConfig;

pub(crate) async fn load_agent(
    pool: &PgPool,
    agent_id: &str,
) -> Result<ManagedAgentRow, GatewayError> {
    registry::repository::get(pool, agent_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("agent not found".to_owned()))
}

pub(crate) fn teams_config(agent: &ManagedAgentRow) -> Result<TeamsAgentConfig, GatewayError> {
    serde_json::from_value(
        agent
            .config
            .get("teams")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )
    .map_err(GatewayError::InvalidJson)
}

pub(crate) fn app_password_key(agent_id: &str, config: &TeamsAgentConfig) -> String {
    config
        .app_password_key
        .clone()
        .unwrap_or_else(|| format!("TEAMS_{agent_id}_APP_PASSWORD"))
}

pub(crate) async fn load_app_password(
    state: &crate::proxy::state::AppState,
    agent_id: &str,
    config: &TeamsAgentConfig,
) -> Result<String, GatewayError> {
    load_secret(state, &app_password_key(agent_id, config)).await
}

#[allow(dead_code)]
pub(crate) async fn update_teams_config(
    pool: &PgPool,
    agent: &ManagedAgentRow,
    patch: Value,
) -> Result<(), GatewayError> {
    let config = patched_teams_config(&agent.config, patch);
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

fn patched_teams_config(config: &Value, patch: Value) -> Value {
    let mut root = config.as_object().cloned().unwrap_or_default();
    let mut teams = root
        .get("teams")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(patch) = patch.as_object() {
        for (key, value) in patch {
            teams.insert(key.clone(), value.clone());
        }
    }
    root.insert("teams".to_owned(), Value::Object(teams));
    Value::Object(root)
}
