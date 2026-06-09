use std::collections::HashMap;

use sqlx::PgPool;

use crate::{
    agents::config::AgentDefinition,
    db::managed_agents::{registry, skills::compose::compose_agent_system_prompt},
    errors::GatewayError,
};

pub(super) async fn managed_agent_definition(
    pool: &PgPool,
    agent: &registry::schema::ManagedAgentRow,
) -> Result<AgentDefinition, GatewayError> {
    Ok(AgentDefinition {
        id: Some(agent.id.clone()),
        name: agent.name.clone(),
        description: agent.description.clone(),
        model: agent.model.clone(),
        harness: Some(agent.harness.clone()),
        system: compose_agent_system_prompt(pool, agent).await?,
        mcp_servers: Vec::new(),
        tools: Vec::<HashMap<String, serde_yaml::Value>>::new(),
        skills: Vec::new(),
    })
}
