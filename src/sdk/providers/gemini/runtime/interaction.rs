use serde_json::{json, Map, Value};

use crate::sdk::agents::{
    AgentEvent, AgentSdkError, Lap, SendEventsParams,
};

use super::DEFAULT_ENVIRONMENT_ID;

pub(super) struct GeminiContext {
    pub(super) agent_id: String,
    pub(super) environment_id: String,
    pub(super) interaction_id: Option<String>,
}

pub(super) fn interaction_body(
    context: &GeminiContext,
    params: &SendEventsParams,
) -> Result<Value, AgentSdkError> {
    let mut body = Map::new();
    body.insert("agent".to_owned(), Value::String(context.agent_id.clone()));
    body.insert("input".to_owned(), input_from_events(&params.events)?);
    body.insert(
        "environment".to_owned(),
        Value::String(context.environment_id.clone()),
    );
    body.insert("store".to_owned(), Value::Bool(true));
    if let Some(interaction_id) = &context.interaction_id {
        body.insert(
            "previous_interaction_id".to_owned(),
            Value::String(interaction_id.clone()),
        );
    }
    Ok(Value::Object(body))
}

fn input_from_events(events: &[Value]) -> Result<Value, AgentSdkError> {
    let mut parts = Vec::new();
    for event in events {
        if event.get("type").and_then(Value::as_str) != Some("user.message") {
            continue;
        }
        match event.get("content") {
            Some(Value::String(text)) => parts.push(json!({ "type": "text", "text": text })),
            Some(Value::Array(content)) => {
                for item in content {
                    if let Some(text) = item.as_str() {
                        parts.push(json!({ "type": "text", "text": text }));
                    } else if item.is_object() {
                        parts.push(item.clone());
                    }
                }
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        return Err(AgentSdkError::InvalidRequest(
            "gemini_antigravity requires at least one user.message content block".to_owned(),
        ));
    }
    if parts.len() == 1 {
        if let Some(text) = parts[0].get("text").and_then(Value::as_str) {
            return Ok(Value::String(text.to_owned()));
        }
    }
    Ok(Value::Array(parts))
}

pub(super) fn gemini_context(
    client: &Lap,
    session_id: &str,
) -> Result<GeminiContext, AgentSdkError> {
    let context = client.context_for_session(session_id)?;
    let agent_id = context
        .as_ref()
        .and_then(|context| context.agent_id.clone())
        .ok_or_else(|| {
            AgentSdkError::InvalidRequest(
                "gemini_antigravity session is missing provider agent id".to_owned(),
            )
        })?;
    Ok(GeminiContext {
        agent_id,
        environment_id: context
            .as_ref()
            .and_then(|context| context.provider_session_id.clone())
            .unwrap_or_else(|| DEFAULT_ENVIRONMENT_ID.to_owned()),
        interaction_id: context.and_then(|context| context.run_id),
    })
}

pub(super) fn interaction_is_terminal(raw: &Value) -> bool {
    matches!(
        raw.get("status").and_then(Value::as_str),
        Some("completed" | "failed" | "cancelled" | "incomplete" | "budget_exceeded")
    )
}

pub(super) fn event_key(event: &AgentEvent) -> String {
    serde_json::to_string(event).unwrap_or_else(|_| event.event_type.clone())
}
