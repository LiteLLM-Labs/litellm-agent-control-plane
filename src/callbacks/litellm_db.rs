use std::{future::Future, pin::Pin};

use sqlx::PgPool;
use tokio::{
    sync::mpsc,
    time::{self, Duration},
};

use crate::{
    callbacks::{
        base::BaseCallback,
        events::{CallbackEventPayload, MANAGED_RUNTIME_SESSION_EVENT},
        standard_logging::StandardLoggingPayload,
    },
    db::managed_agents::runtime_events,
    proxy::config::GeneralSettings,
};

#[derive(Clone)]
pub struct LiteLLMDBCallback {
    spend_sender: mpsc::Sender<StandardLoggingPayload>,
    pool: PgPool,
}

impl LiteLLMDBCallback {
    pub fn new(pool: PgPool, settings: &GeneralSettings) -> Self {
        let (spend_sender, receiver) = mpsc::channel(settings.spend_logs_queue_capacity);
        let writer = BatchWriter {
            pool: pool.clone(),
            receiver,
            batch_size: settings.spend_logs_batch_size,
            interval: Duration::from_secs(settings.spend_logs_batch_interval_seconds),
            store_bodies: settings.store_prompts_in_spend_logs,
        };
        tokio::spawn(writer.run());
        Self { spend_sender, pool }
    }

    fn enqueue_spend_log(&self, payload: StandardLoggingPayload) {
        if let Err(error) = self.spend_sender.try_send(payload) {
            tracing::warn!("spend log callback queue full or closed: {error}");
        }
    }
}

impl BaseCallback for LiteLLMDBCallback {
    fn on_success(&self, payload: StandardLoggingPayload) {
        self.enqueue_spend_log(payload);
    }

    fn on_error(&self, payload: StandardLoggingPayload) {
        self.enqueue_spend_log(payload);
    }

    fn on_event<'a>(
        &'a self,
        payload: CallbackEventPayload,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            if let Err(error) = insert_event_payload(&self.pool, payload).await {
                tracing::warn!("failed to write callback event: {error}");
            }
        })
    }
}

struct BatchWriter {
    pool: PgPool,
    receiver: mpsc::Receiver<StandardLoggingPayload>,
    batch_size: usize,
    interval: Duration,
    store_bodies: bool,
}

impl BatchWriter {
    async fn run(mut self) {
        let mut pending = Vec::with_capacity(self.batch_size);
        let mut ticker = time::interval(self.interval);
        loop {
            tokio::select! {
                Some(payload) = self.receiver.recv() => {
                    pending.push(payload);
                    if pending.len() >= self.batch_size {
                        self.flush(&mut pending).await;
                    }
                }
                _ = ticker.tick() => {
                    self.flush(&mut pending).await;
                }
                else => {
                    self.flush(&mut pending).await;
                    break;
                }
            }
        }
    }

    async fn flush(&self, pending: &mut Vec<StandardLoggingPayload>) {
        if pending.is_empty() {
            return;
        }
        let batch = std::mem::take(pending);
        for payload in batch {
            if let Err(error) = insert_payload(&self.pool, payload, self.store_bodies).await {
                tracing::warn!("failed to write spend log: {error}");
            }
        }
    }
}

async fn insert_event_payload(
    pool: &PgPool,
    payload: CallbackEventPayload,
) -> Result<(), crate::errors::GatewayError> {
    if payload.event != MANAGED_RUNTIME_SESSION_EVENT {
        return Ok(());
    }
    let Some(session_id) = payload.session_id.as_deref() else {
        return Ok(());
    };
    let Some(event) = payload.runtime_event() else {
        return Ok(());
    };
    runtime_events::repository::append(pool, session_id, event).await?;
    Ok(())
}

async fn insert_payload(
    pool: &PgPool,
    payload: StandardLoggingPayload,
    store_bodies: bool,
) -> Result<(), sqlx::Error> {
    let messages = if store_bodies {
        payload.request
    } else {
        serde_json::json!({})
    };
    let response = if store_bodies {
        payload.response.unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    sqlx::query(
        r#"
        INSERT INTO "LiteLLM_SpendLogs" (
          request_id, call_type, api_key, spend, total_tokens, prompt_tokens,
          completion_tokens, "startTime", "endTime", request_duration_ms,
          model, model_id, model_group, custom_llm_provider, api_base, "user",
          metadata, cache_hit, cache_key, request_tags, end_user,
          requester_ip_address, messages, response, status
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, to_timestamp($8::DOUBLE PRECISION), to_timestamp($9::DOUBLE PRECISION), $10,
          $11, $12, $13, $14, $15, '',
          $16, $17, $18, $19, $20,
          $21, $22, $23, $24
        )
        ON CONFLICT (request_id) DO UPDATE SET
          spend = EXCLUDED.spend,
          total_tokens = EXCLUDED.total_tokens,
          prompt_tokens = EXCLUDED.prompt_tokens,
          completion_tokens = EXCLUDED.completion_tokens,
          "endTime" = EXCLUDED."endTime",
          request_duration_ms = EXCLUDED.request_duration_ms,
          metadata = EXCLUDED.metadata,
          messages = EXCLUDED.messages,
          response = EXCLUDED.response,
          status = EXCLUDED.status
        "#,
    )
    .bind(payload.id)
    .bind(payload.call_type)
    .bind(
        payload
            .metadata
            .get("user_api_key_hash")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    )
    .bind(payload.response_cost)
    .bind(payload.usage.total_tokens as i32)
    .bind(payload.usage.prompt_tokens as i32)
    .bind(payload.usage.completion_tokens as i32)
    .bind(payload.start_time)
    .bind(payload.end_time)
    .bind((payload.response_time * 1000.0).round() as i32)
    .bind(payload.model)
    .bind(payload.model_id.unwrap_or_default())
    .bind(payload.model_group.unwrap_or_default())
    .bind(payload.custom_llm_provider)
    .bind(payload.api_base)
    .bind(payload.metadata)
    .bind(payload.cache_hit.to_string())
    .bind(payload.cache_key.unwrap_or_default())
    .bind(payload.request_tags)
    .bind(payload.end_user.unwrap_or_default())
    .bind(payload.requester_ip_address)
    .bind(messages)
    .bind(response)
    .bind(payload.status.as_str())
    .execute(pool)
    .await?;
    Ok(())
}
