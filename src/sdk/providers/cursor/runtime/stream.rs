use std::collections::HashSet;

use async_stream::try_stream;
use futures_util::StreamExt;
use serde_json::{json, Map, Value};

use crate::sdk::agents::{AgentEvent, AgentEventStream};

pub(super) fn normalize_cursor_stream(mut stream: AgentEventStream) -> AgentEventStream {
    let stream = try_stream! {
        let mut state = CursorStreamState::default();
        while let Some(event) = stream.next().await {
            for event in state.normalize(event?) {
                yield event;
            }
        }
        if let Some(event) = state.flush_agent_message() {
            yield event;
        }
    };
    Box::pin(stream)
}

#[derive(Default)]
struct CursorStreamState {
    assistant_text: String,
    emitted_running: bool,
    emitted_thinking: bool,
    emitted_tool_uses: HashSet<String>,
}

impl CursorStreamState {
    fn normalize(&mut self, event: AgentEvent) -> Vec<AgentEvent> {
        match event.event_type.as_str() {
            "assistant" => {
                if let Some(text) = event.data.get("text").and_then(Value::as_str) {
                    self.assistant_text.push_str(text);
                }
                Vec::new()
            }
            "thinking" => self.thinking_event().into_iter().collect(),
            "tool_call" => self.tool_events(event.data),
            "status" | "result" => self.status_events(event.data),
            "error" => vec![simple_event("session.error", event.data)],
            "done" | "heartbeat" => Vec::new(),
            _ => Vec::new(),
        }
    }

    fn status_events(&mut self, data: Map<String, Value>) -> Vec<AgentEvent> {
        match data.get("status").and_then(Value::as_str) {
            Some("RUNNING") => self.running_event().into_iter().collect(),
            Some("FINISHED") => self.flush_then(simple_event("session.status_idle", idle_data())),
            Some("ERROR") | Some("CANCELLED") | Some("EXPIRED") => {
                self.flush_then(simple_event("session.error", data))
            }
            _ => Vec::new(),
        }
    }

    fn thinking_event(&mut self) -> Option<AgentEvent> {
        if self.emitted_thinking {
            return None;
        }
        self.emitted_thinking = true;
        Some(simple_event("agent.thinking", Map::new()))
    }

    fn tool_events(&mut self, data: Map<String, Value>) -> Vec<AgentEvent> {
        let status = data.get("status").and_then(Value::as_str);
        if status == Some("completed") {
            return self.completed_tool_events(data);
        }
        if status == Some("running") && data.get("args").is_some() {
            return self
                .emit_tool_use(data)
                .map(|event| self.flush_then(event))
                .unwrap_or_default();
        }
        Vec::new()
    }

    fn completed_tool_events(&mut self, data: Map<String, Value>) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        if let Some(event) = self.emit_tool_use(data.clone()) {
            events.extend(self.flush_then(event));
        }
        if let Some(event) = tool_result_event(data) {
            events.push(event);
        }
        events
    }

    fn emit_tool_use(&mut self, data: Map<String, Value>) -> Option<AgentEvent> {
        let call_id = data.get("callId").and_then(Value::as_str)?;
        if !self.emitted_tool_uses.insert(call_id.to_owned()) {
            return None;
        }
        Some(tool_event(data))
    }

    fn running_event(&mut self) -> Option<AgentEvent> {
        if self.emitted_running {
            return None;
        }
        self.emitted_running = true;
        Some(simple_event("session.status_running", Map::new()))
    }

    fn flush_then(&mut self, event: AgentEvent) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        if let Some(message) = self.flush_agent_message() {
            events.push(message);
        }
        events.push(event);
        events
    }

    fn flush_agent_message(&mut self) -> Option<AgentEvent> {
        if self.assistant_text.is_empty() {
            return None;
        }
        let text = std::mem::take(&mut self.assistant_text);
        Some(agent_message_event(text))
    }
}

fn agent_message_event(text: String) -> AgentEvent {
    let mut data = Map::new();
    data.insert(
        "content".to_owned(),
        json!([{ "type": "text", "text": text }]),
    );
    simple_event("agent.message", data)
}

fn tool_event(mut data: Map<String, Value>) -> AgentEvent {
    if let Some(call_id) = data.remove("callId") {
        data.insert("id".to_owned(), call_id);
    }
    if let Some(args) = data.remove("args") {
        data.insert("input".to_owned(), args);
    }
    data.remove("status");
    data.remove("result");
    data.entry("input".to_owned()).or_insert_with(|| json!({}));
    simple_event("agent.tool_use", data)
}

fn tool_result_event(mut data: Map<String, Value>) -> Option<AgentEvent> {
    let call_id = data.remove("callId")?;
    let result = data.remove("result");
    data.clear();
    data.insert("tool_use_id".to_owned(), call_id);
    if let Some(result) = result {
        data.insert("content".to_owned(), json!([text_block(result)]));
    }
    Some(simple_event("agent.tool_result", data))
}

fn text_block(value: Value) -> Value {
    match value {
        Value::String(text) => json!({ "type": "text", "text": text }),
        value => json!({ "type": "text", "text": value.to_string() }),
    }
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
