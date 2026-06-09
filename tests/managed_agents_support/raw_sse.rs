use std::error::Error;

use futures_util::StreamExt;
use serde_json::Value;
use tokio::time::{timeout, Duration};

pub async fn print_stream_until_terminal(
    provider: &str,
    response: reqwest::Response,
) -> Result<(), Box<dyn Error>> {
    let mut parser = RawSseParser::default();
    let mut chunks = response.bytes_stream();
    let mut index = 0usize;

    timeout(Duration::from_secs(240), async {
        while let Some(chunk) = chunks.next().await {
            for event in parser.push(&chunk?)? {
                index += 1;
                print_raw_event(provider, index, &event);
                if event.is_terminal() {
                    return Ok(());
                }
            }
        }
        for event in parser.finish() {
            index += 1;
            print_raw_event(provider, index, &event);
            if event.is_terminal() {
                return Ok(());
            }
        }
        Err(format!("{provider} stream ended without terminal event").into())
    })
    .await?
}

fn print_raw_event(provider: &str, index: usize, event: &RawSseEvent) {
    let payload =
        serde_json::from_str::<Value>(&event.data).unwrap_or(Value::String(event.data.clone()));
    let event_type = payload_type(&payload)
        .or(event.event.as_deref())
        .unwrap_or("<none>");
    println!(
        "{provider} #{index} type={event_type} string={}",
        payload_text(&payload).unwrap_or_default(),
    );
}

fn payload_type(payload: &Value) -> Option<&str> {
    payload.get("type").and_then(Value::as_str)
}

fn payload_text(payload: &Value) -> Option<String> {
    for key in ["text", "delta", "token", "result", "message"] {
        if let Some(text) = payload.get(key).and_then(Value::as_str) {
            return Some(format!("{text:?}"));
        }
    }
    let content = payload.get("content")?.as_array()?;
    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(value) = block.get("text").and_then(Value::as_str) {
                text.push_str(value);
            }
        }
    }
    if text.is_empty() {
        None
    } else {
        Some(format!("{text:?}"))
    }
}

#[derive(Debug, Default)]
struct RawSseParser {
    buffer: String,
    event: Option<String>,
    data: Vec<String>,
}

impl RawSseParser {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<RawSseEvent>, Box<dyn Error>> {
        self.buffer.push_str(std::str::from_utf8(bytes)?);
        let mut events = Vec::new();
        while let Some(index) = self.buffer.find('\n') {
            let mut line = self.buffer[..index].to_owned();
            self.buffer.drain(..=index);
            if line.ends_with('\r') {
                line.pop();
            }
            if let Some(event) = self.process_line(&line) {
                events.push(event);
            }
        }
        Ok(events)
    }

    fn finish(mut self) -> Vec<RawSseEvent> {
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            if let Some(event) = self.process_line(&line) {
                return vec![event];
            }
        }
        self.flush().into_iter().collect()
    }

    fn process_line(&mut self, line: &str) -> Option<RawSseEvent> {
        if line.is_empty() {
            return self.flush();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.event = Some(value.to_owned()),
            "data" => self.data.push(value.to_owned()),
            _ => {}
        }
        None
    }

    fn flush(&mut self) -> Option<RawSseEvent> {
        if self.data.is_empty() {
            self.event = None;
            return None;
        }
        Some(RawSseEvent {
            event: self.event.take(),
            data: std::mem::take(&mut self.data).join("\n"),
        })
    }
}

#[derive(Debug)]
struct RawSseEvent {
    event: Option<String>,
    data: String,
}

impl RawSseEvent {
    fn is_terminal(&self) -> bool {
        let Ok(payload) = serde_json::from_str::<Value>(&self.data) else {
            return false;
        };
        matches!(
            payload.get("type").and_then(Value::as_str),
            Some("session.status_idle" | "session.status_terminated" | "session.error")
        ) || matches!(
            payload.get("status").and_then(Value::as_str),
            Some("FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED")
        ) || self.event.as_deref() == Some("done")
    }
}
