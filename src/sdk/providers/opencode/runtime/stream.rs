use async_stream::try_stream;
use futures_util::StreamExt;
use serde_json::{json, Map, Value};

use crate::sdk::agents::{AgentEvent, AgentEventStream};

pub(super) fn normalize_opencode_stream(
    session_id: String,
    mut stream: AgentEventStream,
) -> AgentEventStream {
    let stream = try_stream! {
        while let Some(event) = stream.next().await {
            if let Some(event) = normalize_event(&session_id, event?) {
                yield event;
            }
        }
    };
    Box::pin(stream)
}

fn normalize_event(session_id: &str, mut event: AgentEvent) -> Option<AgentEvent> {
    if event_session_id(&event) != Some(session_id) {
        return None;
    }
    if event.event_type == "session.idle" {
        event.event_type = "session.status_idle".to_owned();
        event
            .data
            .entry("stop_reason".to_owned())
            .or_insert_with(|| json!({ "type": "end_turn" }));
    }
    if matches!(
        event.event_type.as_str(),
        "message.part.delta" | "message.part.updated"
    ) {
        return assistant_text_event(event.data);
    }
    Some(event)
}

fn event_session_id(event: &AgentEvent) -> Option<&str> {
    session_id_from_data(&event.data)
}

fn session_id_from_data(data: &Map<String, Value>) -> Option<&str> {
    data.get("sessionID").and_then(Value::as_str).or_else(|| {
        data.get("session_id")
            .and_then(Value::as_str)
            .or_else(|| data.get("sessionId").and_then(Value::as_str))
            .or_else(|| nested_str(data, "info", "sessionID"))
            .or_else(|| nested_str(data, "message", "sessionID"))
            .or_else(|| nested_str(data, "part", "sessionID"))
    })
}

fn assistant_text_event(data: Map<String, Value>) -> Option<AgentEvent> {
    let text = text_from_data(&data)?.to_owned();
    let session_id = session_id_from_data(&data).map(str::to_owned);
    let mut output = Map::new();
    output.insert("text".to_owned(), Value::String(text));
    if let Some(session_id) = session_id {
        output.insert("sessionID".to_owned(), Value::String(session_id));
    }
    Some(AgentEvent {
        event_type: "assistant_response".to_owned(),
        data: output,
    })
}

fn text_from_data(data: &Map<String, Value>) -> Option<&str> {
    data.get("text")
        .and_then(Value::as_str)
        .or_else(|| data.get("delta").and_then(Value::as_str))
        .or_else(|| nested_str(data, "delta", "text"))
        .or_else(|| nested_str(data, "part", "text"))
}

fn nested_str<'a>(data: &'a Map<String, Value>, parent: &str, field: &str) -> Option<&'a str> {
    data.get(parent)
        .and_then(Value::as_object)
        .and_then(|value| value.get(field))
        .and_then(Value::as_str)
}
