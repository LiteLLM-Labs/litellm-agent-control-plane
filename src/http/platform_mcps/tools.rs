use std::sync::Arc;

use futures_util::StreamExt;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::managed_agents::{memory, registry},
    errors::GatewayError,
    proxy::state::AppState,
    sdk::agents::{AgentEvent, AgentEventKind, AgentEventPayload},
};

use super::{required_str, sub_agent_ids};

pub async fn agent_memory(
    pool: &PgPool,
    agent_id: &str,
    arguments: Value,
) -> Result<Value, GatewayError> {
    if registry::repository::get(pool, agent_id).await?.is_none() {
        return Err(GatewayError::UnknownAgent(agent_id.to_owned()));
    }
    match required_str(&arguments, "action")? {
        "list" => Ok(json!({ "memories": memory::repository::list(pool, agent_id).await? })),
        "get" => {
            let key = required_str(&arguments, "key")?;
            let row = memory::repository::list(pool, agent_id)
                .await?
                .into_iter()
                .find(|row| row.key == key);
            Ok(json!({ "memory": row }))
        }
        "set" => {
            let key = required_str(&arguments, "key")?.to_owned();
            let value = required_str(&arguments, "value")?.to_owned();
            let always_on = arguments.get("always_on").and_then(Value::as_bool);
            Ok(json!({
                "memory": memory::repository::store(pool, agent_id, key, value, always_on).await?
            }))
        }
        action => Err(GatewayError::InvalidJsonMessage(format!(
            "unsupported memory action: {action}"
        ))),
    }
}

pub async fn run_sub_agent(
    state: Arc<AppState>,
    pool: PgPool,
    parent_agent_id: &str,
    arguments: Value,
) -> Result<Value, GatewayError> {
    let child_agent_id = required_str(&arguments, "agent_id")?.to_owned();
    let prompt = required_str(&arguments, "prompt")?.to_owned();
    let parent = registry::repository::get(&pool, parent_agent_id)
        .await?
        .ok_or_else(|| GatewayError::UnknownAgent(parent_agent_id.to_owned()))?;
    let allowed = attached_sub_agents(&pool, &parent).await?;
    let allowed_ids = allowed
        .iter()
        .map(|agent| agent.agent_id.clone())
        .collect::<Vec<_>>();
    if !allowed_ids.iter().any(|id| id == &child_agent_id) {
        return Ok(json!({
            "isError": true,
            "message": "sub-agent is not attached to this parent agent",
            "allowed_sub_agents": allowed
        }));
    }
    let child = registry::repository::get(&pool, &child_agent_id)
        .await?
        .ok_or_else(|| GatewayError::UnknownAgent(child_agent_id.clone()))?;
    let runtime = child_runtime(&child);
    let title = arguments
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or("Sub-agent run")
        .to_owned();
    let session_id = crate::http::sessions::create_runtime_session_for_agent(
        state.clone(),
        &pool,
        child_agent_id.clone(),
        runtime.clone(),
        title,
        prompt,
        json!({}),
    )
    .await?;
    let output = collect_sub_agent_output(state.as_ref(), &pool, &session_id).await?;
    Ok(json!({
        "agent_id": child_agent_id,
        "runtime": runtime,
        "session_id": session_id,
        "status": output.status,
        "output": output.text
    }))
}

pub async fn list_sub_agents(pool: &PgPool, parent_agent_id: &str) -> Result<Value, GatewayError> {
    let parent = registry::repository::get(pool, parent_agent_id)
        .await?
        .ok_or_else(|| GatewayError::UnknownAgent(parent_agent_id.to_owned()))?;
    Ok(json!({ "sub_agents": attached_sub_agents(pool, &parent).await? }))
}

#[derive(serde::Serialize)]
struct AttachedSubAgent {
    agent_id: String,
    name: String,
    description: Option<String>,
    model: String,
    runtime: String,
}

async fn attached_sub_agents(
    pool: &PgPool,
    parent: &registry::schema::ManagedAgentRow,
) -> Result<Vec<AttachedSubAgent>, GatewayError> {
    let mut agents = Vec::new();
    for agent_id in sub_agent_ids(&parent.config) {
        if let Some(agent) = registry::repository::get(pool, &agent_id).await? {
            agents.push(AttachedSubAgent {
                agent_id: agent.id.clone(),
                name: agent.name.clone(),
                description: agent.description.clone(),
                model: agent.model.clone(),
                runtime: child_runtime(&agent),
            });
        }
    }
    Ok(agents)
}

fn child_runtime(agent: &registry::schema::ManagedAgentRow) -> String {
    agent
        .config
        .get("runtime")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|runtime| !runtime.is_empty())
        .unwrap_or(crate::sdk::agents::CLAUDE_MANAGED_AGENTS)
        .to_owned()
}

struct SubAgentOutput {
    status: &'static str,
    text: String,
}

async fn collect_sub_agent_output(
    state: &AppState,
    pool: &PgPool,
    session_id: &str,
) -> Result<SubAgentOutput, GatewayError> {
    let mut stream =
        crate::http::sessions::runtime_event_stream_for_session(state, pool, session_id).await?;
    let mut text = String::new();
    let status: Result<&'static str, GatewayError> =
        tokio::time::timeout(std::time::Duration::from_secs(300), async {
            while let Some(event) = stream.next().await {
                let event = event.map_err(|error| GatewayError::SandboxError(error.to_string()))?;
                match event.kind() {
                    AgentEventKind::AgentMessage => text.push_str(&message_text(&event)),
                    AgentEventKind::SessionStatusIdle => return Ok("completed"),
                    AgentEventKind::SessionError => return Ok("failed"),
                    _ => {}
                }
            }
            Ok("completed")
        })
        .await
        .map_err(|_| GatewayError::SandboxError("sub-agent run timed out".to_owned()))?;
    let status = status?;
    Ok(SubAgentOutput { status, text })
}

fn message_text(event: &AgentEvent) -> String {
    let AgentEventPayload::AgentMessage(message) = event.payload() else {
        return String::new();
    };
    message
        .content
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}
