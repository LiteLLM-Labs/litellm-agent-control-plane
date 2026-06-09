use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use bytes::Bytes;
use serde::Serialize;
use serde_json::Value;

use crate::{agents::sandboxes::AgentOutputChunk, errors::GatewayError};

pub(super) fn connect_json_frame<T: Serialize>(message: &T) -> Result<Vec<u8>, GatewayError> {
    let payload = serde_json::to_vec(message)?;
    let len = u32::try_from(payload.len())
        .map_err(|_| GatewayError::SandboxError("E2B process request is too large".to_owned()))?;
    let mut frame = Vec::with_capacity(payload.len() + 5);
    frame.push(0);
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

#[derive(Default)]
pub(super) struct ConnectJsonDecoder {
    buffer: Vec<u8>,
}

impl ConnectJsonDecoder {
    pub(super) fn decode(&mut self, bytes: Bytes) -> Vec<AgentOutputChunk> {
        if bytes.is_empty() {
            return Vec::new();
        }

        self.buffer.extend_from_slice(&bytes);
        if !looks_like_connect_frame(&self.buffer) {
            let payload = std::mem::take(&mut self.buffer);
            return decode_process_payload(&payload);
        }

        let mut chunks = Vec::new();
        while self.buffer.len() >= 5 {
            let len = frame_payload_len(&self.buffer);
            if self.buffer.len() < len + 5 {
                break;
            }

            let flags = self.buffer[0];
            let payload = self.buffer[5..len + 5].to_vec();
            self.buffer.drain(..len + 5);
            if flags & 0b10 != 0 {
                collect_end_stream_error(&payload, &mut chunks);
            } else {
                chunks.extend(decode_process_payload(&payload));
            }
        }

        chunks
    }
}

fn looks_like_connect_frame(buffer: &[u8]) -> bool {
    buffer.len() < 5 || frame_payload_len(buffer) <= 16 * 1024 * 1024
}

fn frame_payload_len(buffer: &[u8]) -> usize {
    u32::from_be_bytes([buffer[1], buffer[2], buffer[3], buffer[4]]) as usize
}

fn decode_process_payload(bytes: &[u8]) -> Vec<AgentOutputChunk> {
    if bytes.is_empty() {
        return Vec::new();
    }

    let text = String::from_utf8_lossy(bytes);
    let mut chunks = Vec::new();

    let mut saw_process_event = false;
    if let Ok(value) = serde_json::from_str::<Value>(&text) {
        saw_process_event = is_process_lifecycle_event(&value);
        collect_output_chunks(&value, &mut chunks);
    } else {
        for line in text.lines() {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                saw_process_event |= is_process_lifecycle_event(&value);
                collect_output_chunks(&value, &mut chunks);
            }
        }
    }

    if chunks.is_empty() && !saw_process_event {
        chunks.push(AgentOutputChunk::stdout(text.into_owned()));
    }

    chunks
}

fn collect_end_stream_error(bytes: &[u8], chunks: &mut Vec<AgentOutputChunk>) {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return;
    };
    let Some(error) = value.get("error") else {
        return;
    };
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("E2B process stream ended with an error");
    chunks.push(AgentOutputChunk::stderr(message.to_owned()));
}

fn collect_output_chunks(value: &Value, chunks: &mut Vec<AgentOutputChunk>) {
    let Some(object) = value.as_object() else {
        return;
    };

    let mut found = false;
    if let Some(delta) = object.get("stdout").and_then(Value::as_str) {
        chunks.push(AgentOutputChunk::stdout(decode_output_delta(delta)));
        found = true;
    }
    if let Some(delta) = object.get("stderr").and_then(Value::as_str) {
        chunks.push(AgentOutputChunk::stderr(decode_output_delta(delta)));
        found = true;
    }
    if found {
        return;
    }

    for key in ["output", "text", "message"] {
        if let Some(delta) = object.get(key).and_then(Value::as_str) {
            chunks.push(AgentOutputChunk::stdout(decode_output_delta(delta)));
            return;
        }
    }

    for nested in object.values() {
        collect_output_chunks(nested, chunks);
    }
}

fn decode_output_delta(delta: &str) -> String {
    BASE64_STANDARD
        .decode(delta)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| delta.to_owned())
}

fn is_process_lifecycle_event(value: &Value) -> bool {
    value
        .get("event")
        .and_then(Value::as_object)
        .is_some_and(|event| event.contains_key("start") || event.contains_key("end"))
}
