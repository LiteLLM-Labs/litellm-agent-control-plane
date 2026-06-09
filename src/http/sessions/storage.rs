use axum::http::HeaderMap;
use serde_json::json;
use sqlx::PgPool;

use crate::{
    db::managed_agents::{
        messages, registry,
        sessions::{self, schema::SessionRow},
    },
    errors::GatewayError,
    proxy::{auth::master_key::require_master_key, state::AppState},
};

use super::types::{CreateSessionRequest, ResolvedSession};

pub(super) async fn resolve_session_request(
    state: &AppState,
    pool: &PgPool,
    input: CreateSessionRequest,
) -> Result<ResolvedSession, GatewayError> {
    let requested = input.agent.or(input.harness);
    if let Some(agent_id) = requested.as_deref() {
        if agent_id.starts_with("agent_") {
            let agent = registry::repository::get(pool, agent_id)
                .await?
                .ok_or_else(|| GatewayError::UnknownAgent(agent_id.to_owned()))?;
            return Ok(ResolvedSession {
                title: input.title.unwrap_or(agent.name),
                harness: agent.harness,
                agent_id: Some(agent.id),
                timezone: input.timezone.or(input.tz),
            });
        }

        if let Some(agent) = state
            .config
            .agents
            .iter()
            .find(|agent| agent.id() == agent_id)
        {
            return Ok(ResolvedSession {
                title: input.title.unwrap_or_else(|| agent.name.clone()),
                harness: agent.resolved_harness().to_owned(),
                agent_id: Some(agent.id()),
                timezone: input.timezone.or(input.tz),
            });
        }
    }

    let harness = requested
        .filter(|value| value == "claude-code")
        .unwrap_or_else(|| "claude-code".to_owned());
    Ok(ResolvedSession {
        title: input.title.unwrap_or_else(|| "New session".to_owned()),
        harness,
        agent_id: None,
        timezone: input.timezone.or(input.tz),
    })
}

pub(super) async fn persist_message(
    pool: &PgPool,
    session_id: &str,
    role: &str,
    text: &str,
    finish: Option<&str>,
) -> Result<(), GatewayError> {
    persist_message_with_ids(pool, session_id, role, text, finish, None, None).await
}

pub(super) async fn persist_message_with_ids(
    pool: &PgPool,
    session_id: &str,
    role: &str,
    text: &str,
    finish: Option<&str>,
    message_id: Option<&str>,
    part_id: Option<&str>,
) -> Result<(), GatewayError> {
    let message_id = message_id
        .map(str::to_owned)
        .unwrap_or_else(|| crate::db::managed_agents::id("msg"));
    let part_id = part_id
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{message_id}_text"));
    let now = crate::db::managed_agents::now_ms();
    let mut info = json!({
        "id": message_id,
        "role": role,
        "sessionID": session_id,
        "time": { "created": now },
    });
    if let Some(finish) = finish {
        info["finish"] = finish.into();
        info["time"]["completed"] = now.into();
    }
    let parts = json!([{
        "id": part_id,
        "messageID": message_id,
        "sessionID": session_id,
        "type": "text",
        "text": text,
    }]);
    messages::repository::append(pool, session_id, &info.to_string(), &parts.to_string()).await?;
    Ok(())
}

pub(super) async fn session(pool: &PgPool, session_id: &str) -> Result<SessionRow, GatewayError> {
    sessions::repository::get(pool, session_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("session not found".to_owned()))
}

pub(super) fn db<'a>(state: &'a AppState, headers: &HeaderMap) -> Result<&'a PgPool, GatewayError> {
    require_master_key(headers, state.config.general_settings.master_key.as_deref())?;
    state.db.as_ref().ok_or(GatewayError::MissingDatabase)
}
