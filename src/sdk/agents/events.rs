use std::pin::Pin;

use async_stream::try_stream;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::types::AgentSdkError;

pub type AgentEventStream = Pin<Box<dyn Stream<Item = Result<AgentEvent, AgentSdkError>> + Send>>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(flatten)]
    pub data: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum AgentEventKind {
    AgentMessage,
    AgentThinking,
    AgentToolUse,
    AgentToolResult,
    SessionStatusRunning,
    SessionStatusIdle,
    SessionError,
    Unknown(String),
}

impl AgentEventKind {
    pub fn as_str(&self) -> &str {
        match self {
            Self::AgentMessage => "agent.message",
            Self::AgentThinking => "agent.thinking",
            Self::AgentToolUse => "agent.tool_use",
            Self::AgentToolResult => "agent.tool_result",
            Self::SessionStatusRunning => "session.status_running",
            Self::SessionStatusIdle => "session.status_idle",
            Self::SessionError => "session.error",
            Self::Unknown(event_type) => event_type,
        }
    }
}

impl From<&str> for AgentEventKind {
    fn from(value: &str) -> Self {
        match value {
            "agent.message" => Self::AgentMessage,
            "agent.thinking" => Self::AgentThinking,
            "agent.tool_use" => Self::AgentToolUse,
            "agent.tool_result" => Self::AgentToolResult,
            "session.status_running" => Self::SessionStatusRunning,
            "session.status_idle" => Self::SessionStatusIdle,
            "session.error" => Self::SessionError,
            other => Self::Unknown(other.to_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum AgentEventPayload {
    AgentMessage(AgentMessageData),
    AgentThinking,
    AgentToolUse(AgentToolUseData),
    AgentToolResult(AgentToolResultData),
    SessionStatusRunning(SessionStatusData),
    SessionStatusIdle(SessionIdleData),
    SessionError(SessionErrorData),
    Unknown {
        event_type: String,
        data: Map<String, Value>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentMessageData {
    pub content: Vec<Value>,
    pub raw: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentToolUseData {
    pub id: Option<String>,
    pub name: Option<String>,
    pub input: Option<Value>,
    pub raw: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentToolResultData {
    pub tool_use_id: Option<String>,
    pub content: Option<Value>,
    pub raw: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionStatusData {
    pub raw: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionIdleData {
    pub stop_reason: Option<Value>,
    pub raw: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionErrorData {
    pub error: Option<Value>,
    pub raw: Map<String, Value>,
}

impl AgentEvent {
    pub fn new(event_type: impl Into<String>, data: Map<String, Value>) -> Self {
        Self {
            event_type: event_type.into(),
            data,
        }
    }

    pub fn kind(&self) -> AgentEventKind {
        AgentEventKind::from(self.event_type.as_str())
    }

    pub fn payload(&self) -> AgentEventPayload {
        match self.kind() {
            AgentEventKind::AgentMessage => AgentEventPayload::AgentMessage(AgentMessageData {
                content: self
                    .data
                    .get("content")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                raw: self.data.clone(),
            }),
            AgentEventKind::AgentThinking => AgentEventPayload::AgentThinking,
            AgentEventKind::AgentToolUse => AgentEventPayload::AgentToolUse(AgentToolUseData {
                id: string_field(&self.data, "id"),
                name: string_field(&self.data, "name"),
                input: self.data.get("input").cloned(),
                raw: self.data.clone(),
            }),
            AgentEventKind::AgentToolResult => {
                AgentEventPayload::AgentToolResult(AgentToolResultData {
                    tool_use_id: string_field(&self.data, "tool_use_id"),
                    content: self.data.get("content").cloned(),
                    raw: self.data.clone(),
                })
            }
            AgentEventKind::SessionStatusRunning => {
                AgentEventPayload::SessionStatusRunning(SessionStatusData {
                    raw: self.data.clone(),
                })
            }
            AgentEventKind::SessionStatusIdle => {
                AgentEventPayload::SessionStatusIdle(SessionIdleData {
                    stop_reason: self.data.get("stop_reason").cloned(),
                    raw: self.data.clone(),
                })
            }
            AgentEventKind::SessionError => AgentEventPayload::SessionError(SessionErrorData {
                error: self.data.get("error").cloned(),
                raw: self.data.clone(),
            }),
            AgentEventKind::Unknown(event_type) => AgentEventPayload::Unknown {
                event_type,
                data: self.data.clone(),
            },
        }
    }
}

#[derive(Debug, Default)]
pub struct SseParser {
    buffer: String,
    event_name: Option<String>,
    data_lines: Vec<String>,
}

impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<AgentEvent>, AgentSdkError> {
        self.buffer.push_str(std::str::from_utf8(bytes)?);
        let mut events = Vec::new();
        while let Some(index) = self.buffer.find('\n') {
            let mut line = self.buffer[..index].to_owned();
            self.buffer.drain(..=index);
            if line.ends_with('\r') {
                line.pop();
            }
            if let Some(event) = self.process_line(&line)? {
                events.push(event);
            }
        }
        Ok(events)
    }

    pub fn finish(mut self) -> Result<Vec<AgentEvent>, AgentSdkError> {
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            let event = self.process_line(&line)?;
            if let Some(event) = event {
                return Ok(vec![event]);
            }
        }
        self.flush()
    }

    fn process_line(&mut self, line: &str) -> Result<Option<AgentEvent>, AgentSdkError> {
        if line.is_empty() {
            return self.flush().map(|mut events| events.pop());
        }
        if line.starts_with(':') {
            return Ok(None);
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.event_name = Some(value.to_owned()),
            "data" => self.data_lines.push(value.to_owned()),
            _ => {}
        }
        Ok(None)
    }

    fn flush(&mut self) -> Result<Vec<AgentEvent>, AgentSdkError> {
        if self.data_lines.is_empty() {
            self.event_name = None;
            return Ok(Vec::new());
        }
        let event = parse_event(self.event_name.take(), self.data_lines.join("\n"))?;
        self.data_lines.clear();
        Ok(vec![event])
    }
}

pub fn parse_sse(input: &str) -> Result<Vec<AgentEvent>, AgentSdkError> {
    let mut parser = SseParser::default();
    let mut events = parser.push(input.as_bytes())?;
    events.extend(parser.finish()?);
    Ok(events)
}

pub(crate) fn stream_events(response: reqwest::Response) -> AgentEventStream {
    let stream = try_stream! {
        let mut parser = SseParser::default();
        let mut chunks = response.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            for event in parser.push(&chunk?)? {
                yield event;
            }
        }
        for event in parser.finish()? {
            yield event;
        }
    };
    Box::pin(stream)
}

fn parse_event(event_name: Option<String>, payload: String) -> Result<AgentEvent, AgentSdkError> {
    let mut value: Value = serde_json::from_str(&payload)?;
    if let Some(event_name) = event_name {
        if let Some(object) = value.as_object_mut() {
            object
                .entry("type")
                .or_insert_with(|| Value::String(event_name));
        }
    }
    serde_json::from_value(value).map_err(AgentSdkError::Json)
}

fn string_field(data: &Map<String, Value>, field: &str) -> Option<String> {
    data.get(field).and_then(Value::as_str).map(str::to_owned)
}

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;
