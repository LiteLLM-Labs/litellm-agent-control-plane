use std::convert::Infallible;

use axum::body::Bytes;
use serde::Serialize;
use serde_json::json;

use crate::{
    db::managed_agents::{runtime_refs, sessions::schema::SessionRow},
    errors::GatewayError,
    http::provider_errors,
    sdk::agents::{
        AgentRuntime, AgentSdkError, Lap, LapConfig, ManagedSessionRef, SendEventsParams,
    },
};
use sqlx::PgPool;

pub(super) fn runtime_sdk_client(
    resolved: &crate::http::runtime_resolution::ResolvedRuntime,
) -> Result<Lap, GatewayError> {
    lap_from_credential(resolved)
}

pub(crate) fn lap_from_credential(
    resolved: &crate::http::runtime_resolution::ResolvedRuntime,
) -> Result<Lap, GatewayError> {
    let mut config = LapConfig::default();
    match resolved.agent_runtime {
        AgentRuntime::ClaudeManagedAgents => {
            config.anthropic_api_key = Some(resolved.credential.api_key.clone());
            config.anthropic_base_url = resolved.credential.api_base.clone();
        }
        AgentRuntime::Cursor => {
            config.cursor_api_key = Some(resolved.credential.api_key.clone());
            config.cursor_base_url = resolved.credential.api_base.clone();
        }
        AgentRuntime::GeminiAntigravity => {
            config.gemini_api_key = Some(resolved.credential.api_key.clone());
            config.gemini_base_url = resolved.credential.api_base.clone();
        }
        AgentRuntime::ElasticAgentBuilder => {
            config.elastic_api_key = Some(resolved.credential.api_key.clone());
            config.elastic_base_url = resolved.credential.api_base.clone();
        }
    }
    Ok(Lap::new(config))
}

pub(super) async fn register_runtime_session(
    client: &Lap,
    pool: &PgPool,
    row: &SessionRow,
    resolved: &crate::http::runtime_resolution::ResolvedRuntime,
) -> Result<(), GatewayError> {
    let provider_session_id = row.provider_session_id.clone().ok_or_else(|| {
        GatewayError::InvalidConfig(format!(
            "{} session is missing provider_session_id",
            resolved.alias
        ))
    })?;
    let provider_agent_id = resolved
        .adapter
        .provider_agent_id_from_session_id(&provider_session_id);
    let provider_agent_id = match provider_agent_id {
        Some(provider_agent_id) => Some(provider_agent_id),
        None => runtime_agent_id_from_ref(pool, row).await?,
    };
    client
        .register_session(ManagedSessionRef {
            session_id: row.id.clone(),
            lap_agent_runtime: resolved.agent_runtime,
            provider_agent_id,
            provider_session_id: Some(provider_session_id),
            provider_run_id: row.provider_run_id.clone(),
        })
        .map_err(agent_sdk_error)
}

async fn runtime_agent_id_from_ref(
    pool: &PgPool,
    row: &SessionRow,
) -> Result<Option<String>, GatewayError> {
    let Some(runtime_agent_ref_id) = row.runtime_agent_ref_id.as_deref() else {
        return Ok(None);
    };
    Ok(
        runtime_refs::repository::get_by_id(pool, runtime_agent_ref_id)
            .await?
            .map(|runtime_ref| runtime_ref.runtime_agent_id),
    )
}

pub(super) fn send_events_params(prompt: String) -> SendEventsParams {
    SendEventsParams {
        events: vec![json!({
            "type": "user.message",
            "content": [{ "type": "text", "text": prompt }]
        })],
    }
}

pub(super) fn provider_event_line<T: Serialize>(
    event: Result<T, AgentSdkError>,
) -> Result<Bytes, Infallible> {
    let line = match event {
        Ok(event) => match serde_json::to_string(&event) {
            Ok(payload) => format!("data: {payload}\n\n"),
            Err(error) => error_event_line(error.to_string()),
        },
        Err(error) => error_event_line(agent_sdk_error_message(error)),
    };
    Ok(Bytes::from(line))
}

pub(super) fn provider_error_event_line(message: String) -> Result<Bytes, Infallible> {
    Ok(Bytes::from(error_event_line(message)))
}

pub(super) fn agent_sdk_error(error: AgentSdkError) -> GatewayError {
    provider_errors::agent_sdk_error(error)
}

pub(super) fn agent_sdk_error_message(error: AgentSdkError) -> String {
    provider_errors::agent_sdk_error_message(error)
}

fn error_event_line(message: String) -> String {
    format!(
        "data: {}\n\n",
        json!({ "type": "session.error", "error": { "message": message } })
    )
}
