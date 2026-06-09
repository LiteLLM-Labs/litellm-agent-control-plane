use serde::Deserialize;
use serde_json::json;

use crate::agents::{
    config::AgentDefinition,
    events,
    harnesses::{is_stdout, HarnessEvent, HarnessEvents, HarnessRunContext, HarnessRunSpec},
    sandboxes::AgentOutputChunk,
};

pub const ID: &str = "claude-code";

pub fn build_run(agent: &AgentDefinition, prompt: &str) -> HarnessRunSpec {
    HarnessRunSpec {
        command: format!(
            "set -euo pipefail\nnpm install --silent --no-audit --no-fund @anthropic-ai/claude-agent-sdk@latest >/dev/null\nLITELLM_AGENT_PROMPT={} LITELLM_AGENT_MODEL={} LITELLM_AGENT_SYSTEM={} node --input-type=module <<'LITELLM_CLAUDE_AGENT_SDK'\n{}\nLITELLM_CLAUDE_AGENT_SDK",
            shell_quote(prompt),
            shell_quote(&agent.model),
            shell_quote(&agent.system),
            CLAUDE_AGENT_SDK_SCRIPT
        ),
        events: HarnessEvents::ClaudeCode(ClaudeCodeEvents::default()),
    }
}

const CLAUDE_AGENT_SDK_SCRIPT: &str = r#"import { query } from "@anthropic-ai/claude-agent-sdk";

const prompt = process.env.LITELLM_AGENT_PROMPT ?? "";
const model = process.env.LITELLM_AGENT_MODEL || undefined;
const append = process.env.LITELLM_AGENT_SYSTEM || undefined;
const startedAt = Date.now();
let sawResult = false;
let text = "";

const options = {
  includePartialMessages: true,
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  systemPrompt: append
    ? { type: "preset", preset: "claude_code", append }
    : { type: "preset", preset: "claude_code" },
  ...(model ? { model } : {}),
};

function write(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => block && block.type === "text" && typeof block.text === "string" ? block.text : "")
    .join("");
}

function toFrames(message) {
  if (!message || typeof message !== "object") return [];
  switch (message.type) {
    case "system":
      return [];
    case "assistant":
      return [{
        type: "assistant",
        message: {
          model: message.message?.model,
          content: message.message?.content ?? [],
        },
        parent_tool_use_id: message.parent_tool_use_id ?? null,
      }];
    case "user":
      return [{ type: "user", message: message.message }];
    case "stream_event":
      return [{
        type: "stream_event",
        session_id: message.session_id,
        event: message.event,
      }];
    case "result":
      return [{
        type: "result",
        subtype: message.subtype ?? (message.is_error ? "error_during_execution" : "success"),
        session_id: message.session_id,
        duration_ms: message.duration_ms ?? 0,
        duration_api_ms: message.duration_api_ms ?? 0,
        is_error: Boolean(message.is_error),
        num_turns: message.num_turns ?? 1,
        total_cost_usd: message.total_cost_usd ?? 0,
        usage: message.usage ?? {},
        result: message.result ?? "",
      }];
    default:
      return [];
  }
}

for await (const message of query({ prompt, options })) {
  for (const frame of toFrames(message)) {
    if (frame.type === "assistant") text += contentText(frame.message?.content);
    if (frame.type === "result") sawResult = true;
    write(frame);
  }
}

if (!sawResult) {
  const duration = Math.max(0, Date.now() - startedAt);
  write({
    type: "result",
    subtype: "success",
    session_id: "lite-harness",
    duration_ms: duration,
    duration_api_ms: duration,
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {},
    result: text,
  });
}
"#;

#[derive(Debug, Clone, Default)]
pub struct ClaudeCodeEvents {
    stdout_buffer: String,
}

impl ClaudeCodeEvents {
    pub fn start(&self, context: &HarnessRunContext) -> Vec<HarnessEvent> {
        vec![
            HarnessEvent::new(
                events::SESSION_STATUS,
                json!({ "status": { "type": "busy" } }),
            ),
            HarnessEvent::new(
                events::MESSAGE_UPDATED,
                json!({
                    "info": {
                        "id": context.message_id,
                        "role": "assistant",
                        "sessionID": context.run_id,
                    }
                }),
            ),
            HarnessEvent::new(
                events::MESSAGE_PART_UPDATED,
                json!({
                    "part": {
                        "id": context.part_id,
                        "messageID": context.message_id,
                        "sessionID": context.run_id,
                        "type": "text",
                        "text": "",
                    }
                }),
            ),
        ]
    }

    pub fn output(
        &mut self,
        context: &HarnessRunContext,
        output: AgentOutputChunk,
    ) -> Vec<HarnessEvent> {
        if output.delta.is_empty() || !is_stdout(output.stream) {
            return Vec::new();
        }

        self.stdout_buffer.push_str(&output.delta);
        let mut events = Vec::new();
        while let Some(newline) = self.stdout_buffer.find('\n') {
            let line = self.stdout_buffer[..newline].to_owned();
            self.stdout_buffer.drain(..=newline);
            let Ok(output) = serde_json::from_str::<ClaudeCodeOutput>(&line) else {
                continue;
            };
            match output {
                ClaudeCodeOutput::StreamEvent { event } => {
                    if let Some(text) = stream_event_text_delta(&event) {
                        events.push(text_delta_event(context, text));
                    }
                }
                ClaudeCodeOutput::Result { is_error, result } if is_error => {
                    events.push(HarnessEvent::new(
                        events::SESSION_ERROR,
                        json!({ "error": { "message": result } }),
                    ));
                }
                _ => {}
            }
        }
        events
    }

    pub fn complete(&self, context: &HarnessRunContext) -> Vec<HarnessEvent> {
        vec![
            HarnessEvent::new(
                events::MESSAGE_UPDATED,
                json!({
                    "info": {
                        "id": context.message_id,
                        "role": "assistant",
                        "finish": "stop",
                        "sessionID": context.run_id,
                    }
                }),
            ),
            HarnessEvent::new(events::SESSION_IDLE, json!({ "sessionID": context.run_id })),
        ]
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClaudeCodeOutput {
    StreamEvent {
        event: serde_json::Value,
    },
    Result {
        #[serde(default)]
        is_error: bool,
        #[serde(default)]
        result: String,
    },
    #[serde(other)]
    Other,
}

fn text_delta_event(context: &HarnessRunContext, text: String) -> HarnessEvent {
    HarnessEvent::new(
        events::MESSAGE_PART_DELTA,
        json!({
            "messageID": context.message_id,
            "partID": context.part_id,
            "field": "text",
            "delta": text,
        }),
    )
}

fn stream_event_text_delta(event: &serde_json::Value) -> Option<String> {
    if event.get("type").and_then(serde_json::Value::as_str) != Some("content_block_delta") {
        return None;
    }
    let delta = event.get("delta")?;
    if delta.get("type").and_then(serde_json::Value::as_str) != Some("text_delta") {
        return None;
    }
    delta
        .get("text")
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
