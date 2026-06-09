use serde_json::Value;

use crate::{db::managed_agents::slack, errors::GatewayError};

use super::{
    config::{load_agent, slack_config},
    types::{SlackAgentConfig, SlackIncomingMessage},
};

type ManagedAgentRow = crate::db::managed_agents::registry::schema::ManagedAgentRow;

pub async fn route_agent(
    pool: &sqlx::PgPool,
    agent: ManagedAgentRow,
    config: SlackAgentConfig,
    payload: &Value,
    message: &SlackIncomingMessage,
) -> Result<(ManagedAgentRow, SlackAgentConfig), GatewayError> {
    if is_factory_prompt(&message.prompt) {
        return Ok((agent, config));
    }
    let Some(binding) = slack::bindings::get_binding(
        pool,
        &agent.id,
        team_id(payload),
        &message.channel,
        &message.thread_ts,
    )
    .await?
    else {
        return Ok((agent, config));
    };
    let child = load_agent(pool, &binding.agent_id).await?;
    let child_config = slack_config(&child)?;
    Ok((child, child_config))
}

pub(super) fn is_factory_prompt(prompt: &str) -> bool {
    let prompt = prompt.to_ascii_lowercase();
    prompt.contains("make me an agent")
        || prompt.contains("create an agent")
        || prompt.contains("add an agent")
        || prompt.contains("make an agent")
}

fn team_id(payload: &Value) -> Option<&str> {
    payload.get("team_id").and_then(Value::as_str)
}
