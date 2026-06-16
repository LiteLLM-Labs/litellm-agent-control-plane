use std::time::Duration;

use futures_util::StreamExt;
use serde_json::Value;
use sqlx::PgPool;
use tokio::sync::broadcast;

use crate::{
    agents::{events as agent_events, runs::AgentRunStatus},
    errors::GatewayError,
    proxy::state::AppState,
    sdk::agents::{AgentEvent, AgentEventStream},
};

use super::{
    reply::{event_payload, runtime_status, runtime_text},
    repository::persisted_assistant_text_after,
    types::GoogleChatIncomingMessage,
    web_api,
};

pub(super) struct GoogleChatReply<'a> {
    state: &'a AppState,
    pool: &'a PgPool,
    client: &'a reqwest::Client,
    token: &'a str,
    message: &'a GoogleChatIncomingMessage,
    session_id: &'a str,
    baseline_seq: i32,
    reply_message_name: Option<String>,
    text: String,
    since_update: tokio::time::Instant,
}

impl<'a> GoogleChatReply<'a> {
    pub(super) fn new(
        state: &'a AppState,
        pool: &'a PgPool,
        token: &'a str,
        message: &'a GoogleChatIncomingMessage,
        session_id: &'a str,
        baseline_seq: i32,
        reply_message_name: Option<String>,
    ) -> Self {
        Self {
            state,
            pool,
            client: &state.http,
            token,
            message,
            session_id,
            baseline_seq,
            reply_message_name,
            text: String::new(),
            since_update: tokio::time::Instant::now(),
        }
    }

    pub(super) async fn run(
        &mut self,
        mut rx: broadcast::Receiver<String>,
    ) -> Result<(), GatewayError> {
        loop {
            match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
                Ok(Ok(line)) => {
                    if self.apply_line(&line).await? {
                        return Ok(());
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) | Err(_) => {
                    if self.finish_if_terminal().await? {
                        return Ok(());
                    }
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => return self.finish_closed().await,
            }
        }
    }

    pub(super) async fn run_runtime(
        &mut self,
        mut stream: AgentEventStream,
    ) -> Result<(), GatewayError> {
        loop {
            match tokio::time::timeout(Duration::from_secs(2), stream.next()).await {
                Ok(Some(Ok(event))) => {
                    if self.handle_runtime_event(event).await? {
                        return Ok(());
                    }
                }
                Ok(Some(Err(error))) => {
                    self.replace_text(&format!("Agent run failed: {error}"))
                        .await?;
                    return Err(GatewayError::SandboxError(error.to_string()));
                }
                Ok(None) => return self.finish_closed().await,
                Err(_) => {
                    if self.finish_if_terminal().await? {
                        return Ok(());
                    }
                }
            }
        }
    }

    pub(super) async fn replace_text(&mut self, message: &str) -> Result<(), GatewayError> {
        self.text = message.to_owned();
        self.flush().await
    }

    async fn apply_line(&mut self, line: &str) -> Result<bool, GatewayError> {
        let Some((event_type, properties)) = event_payload(line) else {
            return Ok(false);
        };
        if properties.get("sessionID").and_then(Value::as_str) != Some(self.session_id) {
            return Ok(false);
        }
        self.handle_event(&event_type, &properties).await
    }

    async fn handle_event(
        &mut self,
        event_type: &str,
        properties: &Value,
    ) -> Result<bool, GatewayError> {
        match event_type {
            agent_events::MESSAGE_PART_DELTA => self.handle_delta(properties).await,
            agent_events::SESSION_ERROR => self.finish_error(properties).await,
            agent_events::SESSION_IDLE => self.finish_success().await,
            _ => Ok(false),
        }
    }

    async fn handle_runtime_event(&mut self, event: AgentEvent) -> Result<bool, GatewayError> {
        match event.event_type.as_str() {
            "agent.message"
            | "assistant_response"
            | "message.part.delta"
            | "message.part.updated"
            | "content_block_delta" => {
                if let Some(text) = runtime_text(&event) {
                    self.handle_text_delta(&text).await?;
                }
                Ok(false)
            }
            "session.status_idle" | "session.idle" => self.finish_success().await,
            "session.status" => match runtime_status(&event) {
                Some("idle") => self.finish_success().await,
                Some("error") | Some("failed") => {
                    self.finish_error(&Value::Object(event.data)).await
                }
                _ => Ok(false),
            },
            "session.error" | "error" => self.finish_error(&Value::Object(event.data)).await,
            _ => Ok(false),
        }
    }

    async fn handle_delta(&mut self, properties: &Value) -> Result<bool, GatewayError> {
        if let Some(delta) = properties.get("delta").and_then(Value::as_str) {
            self.handle_text_delta(delta).await?;
        }
        Ok(false)
    }

    async fn handle_text_delta(&mut self, delta: &str) -> Result<(), GatewayError> {
        self.text.push_str(delta);
        if self.reply_message_name.is_some()
            && self.since_update.elapsed() >= Duration::from_secs(2)
            && !self.text.is_empty()
        {
            self.flush().await?;
            self.since_update = tokio::time::Instant::now();
        }
        Ok(())
    }

    async fn finish_error(&mut self, properties: &Value) -> Result<bool, GatewayError> {
        let message = properties
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Agent run failed.");
        self.replace_text(message).await?;
        Ok(true)
    }

    async fn finish_success(&mut self) -> Result<bool, GatewayError> {
        if let Some(text) =
            persisted_assistant_text_after(self.pool, self.session_id, self.baseline_seq).await?
        {
            self.replace_text(&text).await?;
        } else if self.text.trim().is_empty() {
            self.replace_text("Done.").await?;
        } else {
            self.flush().await?;
        }
        Ok(true)
    }

    async fn finish_closed(&mut self) -> Result<(), GatewayError> {
        if let Some(text) =
            persisted_assistant_text_after(self.pool, self.session_id, self.baseline_seq).await?
        {
            self.replace_text(&text).await
        } else if self.text.trim().is_empty() {
            self.replace_text("Agent run ended.").await
        } else {
            self.flush().await
        }
    }

    async fn finish_if_terminal(&mut self) -> Result<bool, GatewayError> {
        if let Some(text) =
            persisted_assistant_text_after(self.pool, self.session_id, self.baseline_seq).await?
        {
            self.replace_text(&text).await?;
            return Ok(true);
        }
        let Some(run) = self.state.agent_runs.get_run(self.session_id) else {
            return Ok(false);
        };
        match run.status {
            AgentRunStatus::Completed => {
                if self.text.trim().is_empty() {
                    self.replace_text("Done.").await?;
                } else {
                    self.flush().await?;
                }
                Ok(true)
            }
            AgentRunStatus::Failed | AgentRunStatus::TimedOut => {
                let text = run.error.as_deref().unwrap_or("Agent run failed.");
                self.replace_text(text).await?;
                Ok(true)
            }
            AgentRunStatus::Starting | AgentRunStatus::Running => Ok(false),
        }
    }

    async fn flush(&mut self) -> Result<(), GatewayError> {
        let text = self.text.trim();
        if text.is_empty() {
            return Ok(());
        }
        let text = web_api::truncate(text);
        if let Some(message_name) = self.reply_message_name.as_deref() {
            web_api::update_message(self.client, self.token, message_name, &text).await
        } else {
            let name = web_api::create_message(
                self.client,
                self.token,
                &self.message.space_name,
                self.message.thread_name.as_deref(),
                &text,
            )
            .await?;
            self.reply_message_name = Some(name);
            Ok(())
        }
    }
}
