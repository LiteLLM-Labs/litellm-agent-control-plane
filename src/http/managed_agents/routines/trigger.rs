use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use sqlx::PgPool;

use crate::{
    agents::config::AgentDefinition,
    db::managed_agents::{
        registry,
        routines::{self, schema::RoutineRow},
        runs::{repository as runs_repository, schema::CreateRun},
        skills::compose::compose_agent_system_prompt,
    },
    errors::GatewayError,
    http::managed_agents::runs::{execution::spawn_managed_agent_run, types::RunCreateResponse},
    proxy::state::AppState,
};

pub async fn trigger(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(routine_id): Path<String>,
) -> Result<(StatusCode, Json<RunCreateResponse>), GatewayError> {
    let pool = crate::http::managed_agents::db(&state, &headers)?.clone();
    let routine = routines::repository::get(&pool, &routine_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("routine not found".to_owned()))?;
    let agent = registry::repository::get(&pool, &routine.agent_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("agent not found".to_owned()))?;
    let prompt = routine_prompt(&routine, &agent);
    let run = create_run(&pool, &routine, &agent, &prompt).await?;
    routines::repository::mark_triggered(&pool, &routine_id, &run.id).await?;
    state.agent_runs.track_run(&routine.agent_id, &run.id);
    spawn_managed_agent_run(
        state.clone(),
        pool.clone(),
        routine.agent_id.clone(),
        managed_agent_definition(&pool, &agent).await?,
        prompt,
        run.id.clone(),
    );
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("localhost");
    let logs_url = format!(
        "http://{host}/api/agents/{}/runs/{}/logs",
        routine.agent_id, run.id
    );
    Ok((
        StatusCode::ACCEPTED,
        Json(RunCreateResponse {
            run_id: run.id,
            agent_id: routine.agent_id,
            session_id: run.session_id.unwrap_or_default(),
            status: run.status,
            event_url: "/event".to_owned(),
            logs_url,
        }),
    ))
}

fn routine_prompt(routine: &RoutineRow, agent: &registry::schema::ManagedAgentRow) -> String {
    if !routine.prompt.trim().is_empty() {
        return routine.prompt.clone();
    }
    agent
        .prompt
        .clone()
        .filter(|prompt| !prompt.trim().is_empty())
        .unwrap_or_else(|| "Proceed with your routine.".to_owned())
}

async fn create_run(
    pool: &PgPool,
    routine: &RoutineRow,
    agent: &registry::schema::ManagedAgentRow,
    prompt: &str,
) -> Result<crate::db::managed_agents::runs::schema::AgentRunRow, GatewayError> {
    runs_repository::create(
        pool,
        &routine.agent_id,
        agent.session_id.clone(),
        CreateRun {
            session_id: None,
            config_overrides: None,
            prompt: Some(prompt.to_owned()),
        },
    )
    .await
}

async fn managed_agent_definition(
    pool: &PgPool,
    agent: &registry::schema::ManagedAgentRow,
) -> Result<AgentDefinition, GatewayError> {
    Ok(AgentDefinition {
        id: Some(agent.id.clone()),
        name: agent.name.clone(),
        description: agent.description.clone(),
        model: agent.model.clone(),
        harness: Some(agent.harness.clone()),
        system: compose_agent_system_prompt(pool, agent).await?,
        mcp_servers: Vec::new(),
        tools: Vec::<HashMap<String, serde_yaml::Value>>::new(),
        skills: Vec::new(),
    })
}
