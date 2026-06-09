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
    reply_chunks::{event_payload, split_at_char_limit, text_len},
    reply_format::{runtime_status, runtime_text, slack_mrkdwn},
    reply_storage::{closed_text, final_text, persisted_assistant_text_after},
    types::SlackIncomingMessage,
    web_api,
};

pub(super) struct SlackReply<'a> {
    state: &'a AppState,
    pool: &'a PgPool,
    bot_token: &'a str,
    channel: &'a str,
    thread_ts: &'a str,
    ts: Option<String>,
    username: &'a str,
    session_id: &'a str,
    baseline_seq: i32,
    text: String,
    segment_start: usize,
    since_update: tokio::time::Instant,
}

pub(super) struct SlackReplyParams<'a> {
    pub state: &'a AppState,
    pub pool: &'a PgPool,
    pub bot_token: &'a str,
    pub message: &'a SlackIncomingMessage,
    pub username: &'a str,
    pub ts: Option<String>,
    pub session_id: &'a str,
    pub baseline_seq: i32,
}

impl<'a> SlackReply<'a> {
    pub(super) fn new(params: SlackReplyParams<'a>) -> Self {
        Self {
            state: params.state,
            pool: params.pool,
            bot_token: params.bot_token,
            channel: &params.message.channel,
            thread_ts: &params.message.reply_thread_ts,
            ts: params.ts,
            username: params.username,
            session_id: params.session_id,
            baseline_seq: params.baseline_seq,
            text: String::new(),
            segment_start: 0,
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
        self.segment_start = 0;
        self.flush_progress().await
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
        if self.ts.is_some()
            && self.since_update.elapsed() >= Duration::from_secs(1)
            && !self.text.is_empty()
        {
            self.flush_progress().await?;
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
        if let Some(text) = self.persisted_text().await? {
            self.finish_with_text(text).await?;
        } else if self.text.trim().is_empty() {
            self.replace_text(&final_text(&self.text)).await?;
        } else {
            self.flush_progress().await?;
        }
        Ok(true)
    }

    async fn finish_closed(&mut self) -> Result<(), GatewayError> {
        if let Some(text) = self.persisted_text().await? {
            self.finish_with_text(text).await
        } else if self.text.trim().is_empty() {
            self.replace_text(&closed_text(&self.text)).await
        } else {
            self.flush_progress().await
        }
    }

    async fn finish_if_terminal(&mut self) -> Result<bool, GatewayError> {
        if let Some(text) = self.persisted_text().await? {
            self.finish_with_text(text).await?;
            return Ok(true);
        }
        let Some(run) = self.state.agent_runs.get_run(self.session_id) else {
            return Ok(false);
        };
        match run.status {
            AgentRunStatus::Completed => {
                if self.text.trim().is_empty() {
                    self.replace_text(&final_text(&self.text)).await?;
                } else {
                    self.flush_progress().await?;
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

    async fn persisted_text(&self) -> Result<Option<String>, GatewayError> {
        persisted_assistant_text_after(self.pool, self.session_id, self.baseline_seq).await
    }

    async fn finish_with_text(&mut self, text: String) -> Result<(), GatewayError> {
        if text.starts_with(&self.text) {
            self.text = text;
            self.flush_progress().await
        } else {
            self.replace_text(&text).await
        }
    }

    async fn flush_progress(&mut self) -> Result<(), GatewayError> {
        loop {
            let active = self.active_segment();
            if text_len(active) <= web_api::MAX_TEXT_CHARS {
                break;
            }
            let (head, next_offset) = split_at_char_limit(active, web_api::MAX_TEXT_CHARS);
            let text = head.to_owned();
            self.update_active(&text).await?;
            self.segment_start += next_offset;
            self.ts = None;
        }
        let active = self.active_segment();
        if !active.is_empty() {
            let text = active.to_owned();
            self.update_active(&text).await?;
        }
        Ok(())
    }

    fn active_segment(&self) -> &str {
        self.text.get(self.segment_start..).unwrap_or_default()
    }

    async fn update_active(&mut self, text: &str) -> Result<(), GatewayError> {
        let text = slack_mrkdwn(text);
        self.ts = Some(
            web_api::upsert_message_as(web_api::UpsertMessageParams {
                client: &self.state.http,
                api_base_url: &self.state.config.slack.api_base_url,
                bot_token: self.bot_token,
                channel: self.channel,
                thread_ts: self.thread_ts,
                ts: self.ts.as_deref(),
                text: &text,
                username: Some(self.username),
            })
            .await?,
        );
        Ok(())
    }
}
