use serde_json::Value;

use crate::sdk::agents::AgentEvent;

pub(super) fn event_payload(line: &str) -> Option<(String, Value)> {
    let data = line.strip_prefix("data: ")?;
    let payload: Value = serde_json::from_str(data.trim()).ok()?;
    Some((
        payload.get("type")?.as_str()?.to_owned(),
        payload.get("properties")?.clone(),
    ))
}

pub(super) fn runtime_text(event: &AgentEvent) -> Option<String> {
    event
        .data
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| event.data.get("delta").and_then(Value::as_str))
        .or_else(|| nested_str(&event.data, "delta", "text"))
        .or_else(|| nested_str(&event.data, "part", "text"))
        .map(str::to_owned)
        .or_else(|| content_text(event.data.get("content")?))
        .or_else(|| content_text(event.data.get("message")?.get("content")?))
}

pub(super) fn runtime_status(event: &AgentEvent) -> Option<&str> {
    event
        .data
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| nested_str(&event.data, "status", "type"))
}

fn content_text(value: &Value) -> Option<String> {
    let blocks = value.as_array()?;
    let text = blocks
        .iter()
        .filter_map(|block| {
            block
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| block.get("content").and_then(Value::as_str))
        })
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
}

fn nested_str<'a>(
    data: &'a serde_json::Map<String, Value>,
    parent: &str,
    field: &str,
) -> Option<&'a str> {
    data.get(parent)
        .and_then(Value::as_object)
        .and_then(|value| value.get(field))
        .and_then(Value::as_str)
}
