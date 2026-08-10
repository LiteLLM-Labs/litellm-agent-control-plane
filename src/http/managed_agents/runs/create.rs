use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};

use crate::{
    db::managed_agents::{
        registry::{self, schema::ManagedAgentRow},
        runs::{repository, schema::CreateRun},
    },
    errors::GatewayError,
    http::{
        agents::{has_configured_agent, parse_run_agent_request, start_configured_agent_run},
        sessions::{create_runtime_session_for_agent_without_prompt, enqueue_prompt_text},
    },
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

use super::{execution::spawn_managed_agent_run, types::RunCreateResponse};

mod definition;

use definition::managed_agent_definition;

pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Json(input): Json<serde_json::Value>,
) -> Result<(StatusCode, Json<serde_json::Value>), GatewayError> {
    require_any_gateway_key(&headers, &state).await?;
    if has_configured_agent(&state, &agent_id) {
        return start_configured_agent_run(state, agent_id, parse_run_agent_request(input)?);
    }

    let Some(pool) = state.db.as_ref() else {
        return Err(GatewayError::MissingDatabase);
    };
    let input: CreateRun = serde_json::from_value(input)?;
    let agent = registry::repository::get(pool, &agent_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("agent not found".to_owned()))?;
    let prompt = input
        .prompt
        .clone()
        .filter(|prompt| !prompt.trim().is_empty())
        .or_else(|| agent.prompt.clone())
        .filter(|prompt| !prompt.trim().is_empty())
        .unwrap_or_else(|| "Proceed with your task.".to_owned());
    if let Some(runtime) = runtime_from_agent(&agent) {
        return start_runtime_session(
            state.clone(),
            pool.clone(),
            agent_id,
            agent,
            prompt,
            runtime,
        )
        .await;
    }
    let run = repository::create(pool, &agent_id, agent.session_id.clone(), input).await?;
    state.agent_runs.track_run(&agent_id, &run.id);
    spawn_managed_agent_run(
        state.clone(),
        pool.clone(),
        agent_id.clone(),
        managed_agent_definition(pool, &agent).await?,
        prompt,
        run.id.clone(),
    );
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("localhost");
    let logs_url = format!("http://{host}/api/agents/{agent_id}/runs/{}/logs", run.id);
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::to_value(RunCreateResponse {
            run_id: run.id,
            agent_id,
            session_id: run.session_id.unwrap_or_default(),
            status: run.status,
            event_url: "/event".to_owned(),
            logs_url,
        })?),
    ))
}

async fn start_runtime_session(
    state: Arc<AppState>,
    pool: sqlx::PgPool,
    agent_id: String,
    agent: ManagedAgentRow,
    prompt: String,
    runtime: String,
) -> Result<(StatusCode, Json<serde_json::Value>), GatewayError> {
    let session_id = create_runtime_session_for_agent_without_prompt(
        state.clone(),
        &pool,
        agent_id.clone(),
        runtime,
        format!("{} run", agent.name),
        serde_json::json!({}),
    )
    .await?;
    let prompt_session_id = session_id.clone();
    let prompt_agent_id = agent_id.clone();
    tokio::spawn(async move {
        if let Err(error) =
            enqueue_prompt_text(state, pool, &prompt_session_id, prompt, agent.model).await
        {
            tracing::warn!(
                agent_id = %prompt_agent_id,
                session_id = %prompt_session_id,
                "manual managed-agent runtime prompt failed: {error}"
            );
        }
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::to_value(RunCreateResponse {
            run_id: session_id.clone(),
            agent_id,
            session_id: session_id.clone(),
            status: "starting".to_owned(),
            event_url: format!("/v1/sessions/{session_id}/events/stream"),
            logs_url: format!("/session/{session_id}/runtime_events/list"),
        })?),
    ))
}

fn runtime_from_agent(agent: &ManagedAgentRow) -> Option<String> {
    agent
        .config
        .get("runtime")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|runtime| !runtime.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            let harness = agent.harness.trim();
            crate::sdk::providers::runtime_registry()
                .entry_for_id(harness)
                .map(|_| harness.to_owned())
        })
}
