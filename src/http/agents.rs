use std::{collections::VecDeque, convert::Infallible, sync::Arc};

use axum::{
    body::{Body, Bytes},
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

use crate::{
    agents::{
        config::AgentDefinition,
        events,
        harnesses::{build_harness_run, HarnessEvent, HarnessRunContext},
        runs::{AgentRunStatus, AgentRunStore},
        sandboxes::{SandboxCommand, SandboxRunner},
    },
    errors::GatewayError,
    proxy::{auth::master_key::require_master_key, state::AppState},
};

pub async fn events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, GatewayError> {
    require_events_master_key(
        &headers,
        &query,
        state.config.general_settings.master_key.as_deref(),
    )?;

    let events = state.agent_runs.event_stream();
    let body_stream = stream::unfold(
        (VecDeque::from(events.snapshot), events.rx),
        |(mut snapshot, mut rx)| async move {
            if let Some(line) = snapshot.pop_front() {
                return Some((Ok::<Bytes, Infallible>(Bytes::from(line)), (snapshot, rx)));
            }
            loop {
                match rx.recv().await {
                    Ok(line) => return Some((Ok(Bytes::from(line)), (snapshot, rx))),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                }
            }
        },
    );

    Response::builder()
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(body_stream))
        .map_err(|error| GatewayError::SandboxError(error.to_string()))
}

fn require_events_master_key(
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    configured: Option<&str>,
) -> Result<(), GatewayError> {
    if query.get("key").map(String::as_str) == configured {
        return Ok(());
    }
    require_master_key(headers, configured)
}

pub fn configured_agent_values(state: &AppState) -> Vec<serde_json::Value> {
    state
        .config
        .agents
        .iter()
        .map(|agent| json!(AgentResponse::from(agent)))
        .collect()
}

pub fn configured_agent_value(state: &AppState, agent_id: &str) -> Option<serde_json::Value> {
    state
        .config
        .agents
        .iter()
        .find(|agent| agent.id() == agent_id)
        .map(|agent| json!(AgentResponse::from(agent)))
}

pub fn has_configured_agent(state: &AppState, agent_id: &str) -> bool {
    state
        .config
        .agents
        .iter()
        .any(|agent| agent.id() == agent_id)
}

pub fn configured_agent_runs_value(state: &AppState, agent_id: &str) -> Option<serde_json::Value> {
    has_configured_agent(state, agent_id)
        .then(|| json!({ "runs": state.agent_runs.list_runs(agent_id) }))
}

pub fn parse_run_agent_request(value: serde_json::Value) -> Result<RunAgentRequest, GatewayError> {
    serde_json::from_value(value).map_err(GatewayError::InvalidJson)
}

pub fn start_configured_agent_run(
    state: Arc<AppState>,
    agent_id: String,
    body: RunAgentRequest,
) -> Result<(StatusCode, Json<serde_json::Value>), GatewayError> {
    let agent = find_agent(&state, &agent_id)?.clone();
    let prompt = body
        .prompt
        .filter(|prompt| !prompt.trim().is_empty())
        .unwrap_or_else(|| "Proceed with your task.".to_owned());
    let run = state.agent_runs.create_run(&agent_id);
    let run_id = run.id.clone();

    spawn_agent_run(state.clone(), agent, prompt, run_id.clone());

    let response = RunAgentResponse {
        run_id,
        agent_id,
        status: "starting",
        event_url: "/event",
    };
    Ok((StatusCode::ACCEPTED, Json(serde_json::to_value(response)?)))
}

fn spawn_agent_run(state: Arc<AppState>, agent: AgentDefinition, prompt: String, run_id: String) {
    tokio::spawn(async move {
        if let Err(error) = execute_agent_run(state.clone(), agent, prompt, &run_id).await {
            let message = error.to_string();
            state.agent_runs.set_error(&run_id, message.clone());
            state.agent_runs.push_event(
                &run_id,
                events::SESSION_ERROR,
                json!({ "error": { "message": message } }),
            );
            state.agent_runs.push_event(
                &run_id,
                events::SESSION_IDLE,
                json!({ "sessionID": run_id }),
            );
        }
    });
}

async fn execute_agent_run(
    state: Arc<AppState>,
    agent: AgentDefinition,
    prompt: String,
    run_id: &str,
) -> Result<(), GatewayError> {
    let store = &state.agent_runs;
    let mut harness_run = build_harness_run(&agent, &prompt)?;
    let context = HarnessRunContext::new(run_id);
    push_harness_events(store, run_id, harness_run.events.start(&context));

    let sandbox = SandboxRunner::from_settings(state.http.clone(), &state.config.general_settings)?;
    let session = sandbox.create(run_id).await?;
    if let Some(sandbox_id) = session.sandbox_id.clone() {
        store.set_sandbox_id(run_id, sandbox_id);
    }
    store.update_status(run_id, AgentRunStatus::Running);
    let run_result = async {
        let mut stream = sandbox
            .start(
                &session,
                SandboxCommand {
                    command: harness_run.command,
                },
            )
            .await?;
        while let Some(output) = stream.next().await {
            let output = output?;
            if output.delta.is_empty() {
                continue;
            }
            let events = harness_run.events.output(&context, output);
            push_harness_events(store, run_id, events);
        }
        Ok::<(), GatewayError>(())
    }
    .await;

    let _ = sandbox.terminate(&session).await;
    run_result?;

    store.update_status(run_id, AgentRunStatus::Completed);
    push_harness_events(store, run_id, harness_run.events.complete(&context));
    Ok(())
}

fn push_harness_events(store: &AgentRunStore, run_id: &str, events: Vec<HarnessEvent>) {
    for event in events {
        store.push_event(run_id, event.event, event.data);
    }
}

fn find_agent<'a>(
    state: &'a AppState,
    agent_id: &str,
) -> Result<&'a AgentDefinition, GatewayError> {
    state
        .config
        .agents
        .iter()
        .find(|agent| agent.id() == agent_id)
        .ok_or_else(|| GatewayError::UnknownAgent(agent_id.to_owned()))
}

#[derive(Debug, Deserialize)]
pub struct RunAgentRequest {
    pub prompt: Option<String>,
}

#[derive(Debug, Serialize)]
struct RunAgentResponse<'a> {
    run_id: String,
    agent_id: String,
    status: &'a str,
    event_url: &'a str,
}

#[derive(Debug, Serialize)]
struct AgentResponse<'a> {
    id: String,
    name: &'a str,
    description: Option<&'a str>,
    model: &'a str,
    harness: &'a str,
    system: &'a str,
    mcp_servers: &'a [serde_yaml::Value],
    tools: &'a [HashMap<String, serde_yaml::Value>],
    skills: &'a [serde_yaml::Value],
}

impl<'a> From<&'a AgentDefinition> for AgentResponse<'a> {
    fn from(agent: &'a AgentDefinition) -> Self {
        Self {
            id: agent.id(),
            name: &agent.name,
            description: agent.description.as_deref(),
            model: &agent.model,
            harness: agent.resolved_harness(),
            system: &agent.system,
            mcp_servers: &agent.mcp_servers,
            tools: &agent.tools,
            skills: &agent.skills,
        }
    }
}
