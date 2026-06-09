use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::managed_agents::{
        registry::{self, schema::ManagedAgentRow},
        slack,
    },
    errors::GatewayError,
    http::managed_agents::slack::config::slack_config,
    proxy::state::AppState,
};

use super::{factory_slack_app, required_str};

pub async fn connect_agent_to_slack(
    state: &AppState,
    pool: &PgPool,
    platform_agent_id: &str,
    arguments: Value,
) -> Result<Value, GatewayError> {
    let agent_id = required_str(&arguments, "agent_id")?;
    let thread_ts = required_str(&arguments, "thread_ts")?;
    let platform = load_agent(pool, platform_agent_id).await?;
    let child = load_agent(pool, agent_id).await?;
    let config = slack_config(&platform)?;
    factory_slack_app::create_child_slack_app(
        state, pool, &platform, child, &config, &arguments, thread_ts,
    )
    .await
}

pub async fn list_slack_bindings(
    pool: &PgPool,
    platform_agent_id: &str,
) -> Result<Value, GatewayError> {
    Ok(json!({
        "bindings": slack::bindings::list_bindings(pool, platform_agent_id).await?
    }))
}

async fn load_agent(pool: &PgPool, agent_id: &str) -> Result<ManagedAgentRow, GatewayError> {
    registry::repository::get(pool, agent_id)
        .await?
        .ok_or_else(|| GatewayError::UnknownAgent(agent_id.to_owned()))
}
