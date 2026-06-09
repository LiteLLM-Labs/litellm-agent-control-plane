use std::sync::Arc;

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::{
        credentials,
        managed_agents::{
            registry::{self, schema::ManagedAgentRow},
            sessions::{self, schema::SessionRow},
        },
    },
    errors::GatewayError,
    proxy::{credential_crypto, state::AppState},
};

use super::{
    runtime_lifecycle::{
        drain_provider_stream, mark_session_error, mark_session_idle, persist_send_response_events,
        provider_run_status, update_agent_run_status,
    },
    runtime_provision::provision_runtime_session,
    runtime_sdk::{agent_sdk_error, register_runtime_session, send_events_params},
    storage::persist_message,
    types::{CreateSessionRequest, SessionResponse},
};

pub(super) struct CreatedRuntimeSession {
    pub(super) runtime: String,
    pub(super) resolved: crate::http::runtime_resolution::ResolvedRuntime,
    pub(super) agent: ManagedAgentRow,
    pub(super) environment: Value,
    pub(super) initial_user_prompt: Option<String>,
    pub(super) prompt: String,
    pub(super) row: SessionRow,
}

pub(super) async fn create_runtime_session(
    state: Arc<AppState>,
    pool: &PgPool,
    input: CreateSessionRequest,
) -> Result<SessionResponse, GatewayError> {
    let created = create_runtime_session_row(&state, pool, input).await?;
    if let Some(prompt) = created.initial_user_prompt.as_deref() {
        persist_message(pool, &created.row.id, "user", prompt, None).await?;
    }
    let mut row = match provision_runtime_session(&state, pool, &created).await {
        Ok(row) => row,
        Err(error) => {
            let _ = sessions::repository::delete(pool, &created.row.id).await;
            return Err(error);
        }
    };
    state.agent_runs.track_run(&created.agent.id, &row.id);
    if row.provider_run_id.is_none() {
        if let Some(prompt) = created.initial_user_prompt.as_deref() {
            execute_runtime_prompt(state.clone(), pool, row.clone(), prompt.to_owned()).await?;
        } else {
            mark_session_idle(&state, pool, &row.id).await?;
            row.status = "idle".to_owned();
        }
    }
    Ok(SessionResponse::from(row))
}

pub(crate) async fn create_runtime_session_for_agent(
    state: Arc<AppState>,
    pool: &PgPool,
    agent_id: String,
    runtime: String,
    title: String,
    prompt: String,
    environment: Value,
) -> Result<String, GatewayError> {
    let runtime = registry::repository::get(pool, &agent_id)
        .await?
        .and_then(|agent| runtime_from_agent_config(&agent))
        .unwrap_or(runtime);
    let response = create_runtime_session(
        state,
        pool,
        CreateSessionRequest {
            title: Some(title),
            harness: None,
            agent: Some(agent_id.clone()),
            agent_id: Some(agent_id),
            runtime: Some(runtime),
            prompt: Some(prompt),
            environment: Some(environment),
            timezone: None,
            tz: None,
        },
    )
    .await?;
    Ok(response.id().to_owned())
}

fn runtime_from_agent_config(agent: &ManagedAgentRow) -> Option<String> {
    agent
        .config
        .get("runtime")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

async fn create_runtime_session_row(
    state: &AppState,
    pool: &PgPool,
    input: CreateSessionRequest,
) -> Result<CreatedRuntimeSession, GatewayError> {
    let alias = input.runtime.as_deref().unwrap_or_default();
    let resolved = crate::http::runtime_resolution::resolve_runtime(pool, state, alias).await?;
    let runtime = resolved.alias.clone();
    let mut agent = load_agent(pool, &input).await?;
    agent.system =
        crate::db::managed_agents::skills::compose::compose_agent_system_prompt(pool, &agent)
            .await?;
    let stored_environment = input.environment.clone().unwrap_or_else(|| json!({}));
    let title = input.title.clone().unwrap_or_else(|| agent.name.clone());
    let initial_user_prompt = input
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
        .map(str::to_owned);
    let row = sessions::repository::create_runtime(
        pool,
        sessions::repository::CreateRuntimeSession {
            runtime: &runtime,
            agent_id: &agent.id,
            title: &title,
            timezone: input.timezone.as_deref().or(input.tz.as_deref()),
            runtime_agent_ref_id: None,
            environment: stored_environment.clone(),
            provider_session_id: None,
            provider_run_id: None,
        },
    )
    .await?;
    let mut provision_environment = stored_environment;
    resolve_agent_vault_keys(state, pool, &agent, &mut provision_environment).await?;
    let prompt = runtime_prompt(input.prompt, &agent);
    Ok(CreatedRuntimeSession {
        runtime,
        resolved,
        agent,
        environment: provision_environment,
        initial_user_prompt,
        prompt,
        row,
    })
}

pub(super) async fn execute_runtime_prompt(
    state: Arc<AppState>,
    pool: &PgPool,
    row: SessionRow,
    prompt: String,
) -> Result<(), GatewayError> {
    let runtime = row.runtime.as_deref().ok_or_else(|| {
        GatewayError::InvalidConfig("runtime session is missing runtime".to_owned())
    })?;
    let resolved = crate::http::runtime_resolution::resolve_runtime(pool, &state, runtime).await?;
    let client = super::runtime_sdk::lap_from_credential(&resolved)?;
    if let Err(error) = register_runtime_session(&client, pool, &row, &resolved).await {
        mark_session_error(&state, pool, &row.id, error.to_string()).await?;
        return Err(error);
    }
    state
        .agent_runs
        .update_status(&row.id, crate::agents::runs::AgentRunStatus::Running);
    let sent = match client
        .beta()
        .sessions()
        .events()
        .send(&row.id, send_events_params(prompt))
        .await
    {
        Ok(sent) => sent,
        Err(error) => {
            let error = agent_sdk_error(error);
            mark_session_error(&state, pool, &row.id, error.to_string()).await?;
            return Err(error);
        }
    };
    let status = provider_run_status(&sent.raw);
    let mut has_provider_run = false;
    if let Some(run_id) = resolved.adapter.provider_run_id_from_agent_raw(&sent.raw) {
        has_provider_run = true;
        sessions::repository::set_provider_run(pool, &row.id, &run_id, status).await?;
        update_agent_run_status(&state, &row.id, status, &sent.raw);
    }
    persist_send_response_events(pool, &resolved, &row.id, &sent.raw).await?;
    if status == "running" && has_provider_run {
        let stream = match client.beta().sessions().events().stream(&row.id).await {
            Ok(stream) => stream,
            Err(error) => {
                let error = agent_sdk_error(error);
                mark_session_error(&state, pool, &row.id, error.to_string()).await?;
                return Err(error);
            }
        };
        drain_provider_stream(&state, pool, &row.id, stream).await?;
    }
    Ok(())
}

async fn load_agent(
    pool: &PgPool,
    input: &CreateSessionRequest,
) -> Result<ManagedAgentRow, GatewayError> {
    let agent_id = input
        .agent_id
        .clone()
        .or(input.agent.clone())
        .ok_or_else(|| GatewayError::InvalidJsonMessage("agent_id is required".to_owned()))?;
    registry::repository::get(pool, &agent_id)
        .await?
        .ok_or_else(|| GatewayError::UnknownAgent(agent_id.clone()))
}

fn runtime_prompt(prompt: Option<String>, agent: &ManagedAgentRow) -> String {
    prompt
        .filter(|prompt| !prompt.trim().is_empty())
        .unwrap_or_else(|| format!("Start a session for {}.", agent.name))
}

async fn resolve_agent_vault_keys(
    state: &AppState,
    pool: &PgPool,
    agent: &ManagedAgentRow,
    environment: &mut Value,
) -> Result<(), GatewayError> {
    let key_names: Vec<String> = agent
        .vault_keys
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    if key_names.is_empty() {
        return Ok(());
    }
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let owner_id = agent.owner_id.as_deref().unwrap_or("");
    let env_obj = environment.as_object_mut().ok_or_else(|| {
        GatewayError::InvalidJsonMessage("environment must be an object".to_owned())
    })?;
    for key_name in &key_names {
        if let Some(encrypted) = credentials::resolve_vault_key(pool, key_name, owner_id).await? {
            if let Ok(plaintext) = credential_crypto::decrypt_value(&encrypted, &enc_key) {
                env_obj.insert(key_name.clone(), serde_json::Value::String(plaintext));
            }
        }
    }
    Ok(())
}
