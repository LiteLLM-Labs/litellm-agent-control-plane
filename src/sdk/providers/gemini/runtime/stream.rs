use serde_json::{json, Map, Value};

use crate::sdk::agents::AgentEvent;

pub(super) fn events_from_interaction(raw: &Value) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    if raw.get("status").and_then(Value::as_str) == Some("in_progress") {
        events.push(simple_event("session.status_running", Map::new()));
    }
    let mut has_message = false;
    for step in raw
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(event) = event_from_step(step) {
            has_message = has_message || event.event_type == "agent.message";
            events.push(event);
        }
    }
    if !has_message {
        if let Some(event) = model_output_from_outputs(raw) {
            events.push(event);
        }
    }
    match raw.get("status").and_then(Value::as_str) {
        Some("completed") => events.push(simple_event("session.status_idle", idle_data())),
        Some("failed" | "cancelled" | "incomplete" | "budget_exceeded") => {
            let mut data = Map::new();
            data.insert(
                "error".to_owned(),
                raw.get("error")
                    .cloned()
                    .unwrap_or_else(|| json!({ "message": "Gemini interaction did not complete" })),
            );
            events.push(simple_event("session.error", data));
        }
        _ => {}
    }
    events
}

pub(super) fn list_events_from_interaction(raw: &Value) -> Vec<Value> {
    events_from_interaction(raw)
        .into_iter()
        .filter_map(|event| serde_json::to_value(event).ok())
        .collect()
}

fn event_from_step(step: &Value) -> Option<AgentEvent> {
    match step.get("type").and_then(Value::as_str)? {
        "model_output" => model_output_event(step),
        "function_call" | "mcp_server_tool_call" => tool_use_event(step),
        "function_result" | "mcp_server_tool_result" => tool_result_event(step),
        "thought" => Some(simple_event("agent.thinking", Map::new())),
        _ => None,
    }
}

fn model_output_event(step: &Value) -> Option<AgentEvent> {
    let content = step
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if content.is_empty() {
        return None;
    }
    let mut data = Map::new();
    data.insert("content".to_owned(), Value::Array(content));
    Some(simple_event("agent.message", data))
}

fn model_output_from_outputs(raw: &Value) -> Option<AgentEvent> {
    let content = raw
        .get("outputs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|output| output.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|output| {
            output
                .get("text")
                .and_then(Value::as_str)
                .map(|text| json!({ "type": "text", "text": text }))
        })
        .collect::<Vec<_>>();
    if content.is_empty() {
        return None;
    }
    let mut data = Map::new();
    data.insert("content".to_owned(), Value::Array(content));
    Some(simple_event("agent.message", data))
}

fn tool_use_event(step: &Value) -> Option<AgentEvent> {
    let mut data = Map::new();
    if let Some(id) = step.get("id").and_then(Value::as_str) {
        data.insert("id".to_owned(), Value::String(id.to_owned()));
    }
    if let Some(name) = step.get("name").and_then(Value::as_str) {
        data.insert("name".to_owned(), Value::String(name.to_owned()));
    }
    if let Some(arguments) = step.get("arguments") {
        data.insert("input".to_owned(), arguments.clone());
    }
    Some(simple_event("agent.tool_use", data))
}

fn tool_result_event(step: &Value) -> Option<AgentEvent> {
    let call_id = step
        .get("call_id")
        .or_else(|| step.get("id"))
        .and_then(Value::as_str)?;
    let mut data = Map::new();
    data.insert("tool_use_id".to_owned(), Value::String(call_id.to_owned()));
    if let Some(result) = step.get("result") {
        data.insert("content".to_owned(), result.clone());
    }
    Some(simple_event("agent.tool_result", data))
}

fn idle_data() -> Map<String, Value> {
    let mut data = Map::new();
    data.insert("stop_reason".to_owned(), json!({ "type": "end_turn" }));
    data
}

fn simple_event(event_type: &str, data: Map<String, Value>) -> AgentEvent {
    AgentEvent {
        event_type: event_type.to_owned(),
        data,
    }
}
