use std::{sync::Arc, time::Duration};

use futures_util::StreamExt;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::managed_agents::{memory, registry},
    errors::GatewayError,
    proxy::state::AppState,
    sdk::agents::{AgentEvent, AgentEventKind, AgentEventPayload, AgentEventStream},
};

use super::{required_str, sub_agent_ids};

const SUB_AGENT_RUN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const SUB_AGENT_STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const SUB_AGENT_INTERRUPT_TIMEOUT: Duration = Duration::from_secs(10);

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
        "output": output.text,
        "error": output.error
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
    error: Option<String>,
}

async fn collect_sub_agent_output(
    state: &AppState,
    pool: &PgPool,
    session_id: &str,
) -> Result<SubAgentOutput, GatewayError> {
    let stream = tokio::time::timeout(
        SUB_AGENT_STREAM_CONNECT_TIMEOUT,
        crate::http::sessions::runtime_event_stream_for_session(state, pool, session_id),
    )
    .await;
    let output = match stream {
        Ok(stream) => collect_sub_agent_stream(stream?, SUB_AGENT_RUN_TIMEOUT).await?,
        Err(_) => SubAgentOutput {
            status: "timed_out",
            text: String::new(),
            error: Some(format!(
                "sub-agent event stream did not connect within {} seconds",
                SUB_AGENT_STREAM_CONNECT_TIMEOUT.as_secs()
            )),
        },
    };
    if output.status == "timed_out" {
        let _ = tokio::time::timeout(
            SUB_AGENT_INTERRUPT_TIMEOUT,
            crate::http::sessions::interrupt_runtime_session(state, pool, session_id),
        )
        .await;
    }
    Ok(output)
}

async fn collect_sub_agent_stream(
    mut stream: AgentEventStream,
    timeout: Duration,
) -> Result<SubAgentOutput, GatewayError> {
    let mut text = String::new();
    let mut message_item_id: Option<String> = None;
    let terminal = tokio::time::timeout(timeout, async {
        while let Some(event) = stream.next().await {
            let event = event.map_err(|error| GatewayError::SandboxError(error.to_string()))?;
            match event.kind() {
                AgentEventKind::AgentMessage => {
                    let next_item_id = agent_message_item_id(&event);
                    if next_item_id != message_item_id {
                        text.clear();
                        message_item_id = next_item_id;
                    }
                    text.push_str(&message_text(&event));
                }
                AgentEventKind::SessionStatusIdle => {
                    return Ok::<(&'static str, Option<String>), GatewayError>(("completed", None))
                }
                AgentEventKind::SessionError => {
                    return Ok(("failed", Some(session_error_message(&event))))
                }
                _ => {}
            }
        }
        Ok((
            "failed",
            Some("sub-agent event stream ended without a terminal event".to_owned()),
        ))
    })
    .await;
    match terminal {
        Ok(result) => {
            let (status, error) = result?;
            Ok(SubAgentOutput {
                status,
                text,
                error,
            })
        }
        Err(_) => Ok(SubAgentOutput {
            status: "timed_out",
            text,
            error: Some(format!(
                "sub-agent run timed out after {} seconds",
                timeout.as_secs()
            )),
        }),
    }
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

fn agent_message_item_id(event: &AgentEvent) -> Option<String> {
    event
        .data
        .get("item_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item_id| !item_id.is_empty())
        .map(str::to_owned)
}

fn session_error_message(event: &AgentEvent) -> String {
    event
        .data
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .unwrap_or("sub-agent run failed")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use futures_util::stream;
    use serde_json::{json, Map};

    use crate::sdk::agents::{AgentEvent, AgentSdkError};

    use super::*;

    fn event(event_type: &str, data: Value) -> AgentEvent {
        AgentEvent::new(
            event_type,
            data.as_object().cloned().unwrap_or_else(Map::new),
        )
    }

    #[tokio::test]
    async fn returns_structured_timeout_for_a_stalled_child() {
        let pending = stream::pending::<Result<AgentEvent, AgentSdkError>>();
        let output = collect_sub_agent_stream(Box::pin(pending), Duration::from_millis(10))
            .await
            .unwrap();

        assert_eq!(output.status, "timed_out");
        assert_eq!(output.text, "");
        assert_eq!(
            output.error.as_deref(),
            Some("sub-agent run timed out after 0 seconds")
        );
    }

    #[tokio::test]
    async fn preserves_child_text_and_terminal_failure() {
        let events = stream::iter(vec![
            Ok(event(
                "agent.message",
                json!({"content": [{"type": "text", "text": "partial result"}]}),
            )),
            Ok(event(
                "session.error",
                json!({"error": {"message": "command timed out"}}),
            )),
        ]);
        let output = collect_sub_agent_stream(Box::pin(events), Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(output.status, "failed");
        assert_eq!(output.text, "partial result");
        assert_eq!(output.error.as_deref(), Some("command timed out"));
    }

    #[tokio::test]
    async fn returns_only_the_final_agent_message_item() {
        let events = stream::iter(vec![
            Ok(event(
                "agent.message",
                json!({
                    "item_id": "commentary-1",
                    "content": [{"type": "text", "text": "Checking the source now."}]
                }),
            )),
            Ok(event(
                "agent.message",
                json!({
                    "item_id": "final-1",
                    "content": [{"type": "text", "text": "{\"status\":"}]
                }),
            )),
            Ok(event(
                "agent.message",
                json!({
                    "item_id": "final-1",
                    "content": [{"type": "text", "text": "\"complete\"}"}]
                }),
            )),
            Ok(event(
                "session.status_idle",
                json!({"stop_reason": {"type": "end_turn"}}),
            )),
        ]);
        let output = collect_sub_agent_stream(Box::pin(events), Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(output.status, "completed");
        assert_eq!(output.text, "{\"status\":\"complete\"}");
        assert_eq!(output.error, None);
    }

    #[tokio::test]
    async fn rejects_a_stream_that_ends_without_a_terminal_event() {
        let events = stream::iter(Vec::<Result<AgentEvent, AgentSdkError>>::new());
        let output = collect_sub_agent_stream(Box::pin(events), Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(output.status, "failed");
        assert_eq!(
            output.error.as_deref(),
            Some("sub-agent event stream ended without a terminal event")
        );
    }
}
