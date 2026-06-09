use std::{collections::HashMap, sync::Arc};

use futures_util::StreamExt;
use sqlx::PgPool;

use crate::{
    agents::{
        config::AgentDefinition,
        events,
        harnesses::{build_harness_run, HarnessEvent, HarnessEvents, HarnessRunContext},
        runs::AgentRunStatus,
        sandboxes::{SandboxCommand, SandboxRunner, SandboxSession},
    },
    db::managed_agents::{
        registry::{self, schema::ManagedAgentRow},
        sessions::schema::SessionRow,
    },
    errors::GatewayError,
    proxy::state::AppState,
};

use super::{runtime::execute_runtime_prompt, storage::persist_message_with_ids};

pub(super) async fn execute_prompt(
    state: Arc<AppState>,
    pool: PgPool,
    row: SessionRow,
    prompt: String,
    model: String,
) -> Result<(), GatewayError> {
    if row.runtime.is_some() {
        return execute_runtime_prompt(state, &pool, row, prompt).await;
    }

    let agent = agent_definition(&pool, &state, &row, &model).await?;
    let mut harness_run = build_harness_run(&agent, &prompt)?;
    let context = HarnessRunContext::new(&row.id);
    push_events(&state, &row.id, harness_run.events.start(&context));

    let sandbox = SandboxRunner::from_settings(state.http.clone(), &state.config.general_settings)?;
    let session = sandbox.create(&row.id).await?;
    mark_sandbox_running(&state, &row, &session);
    let assistant_text = stream_harness_output(
        &state,
        &sandbox,
        &session,
        &row.id,
        harness_run.command,
        &context,
        &mut harness_run.events,
    )
    .await;
    let _ = sandbox.terminate(&session).await;
    persist_assistant_message(&pool, &row.id, &context, &assistant_text?).await?;
    state
        .agent_runs
        .update_status(&row.id, AgentRunStatus::Completed);
    push_events(&state, &row.id, harness_run.events.complete(&context));
    Ok(())
}

async fn stream_harness_output(
    state: &AppState,
    sandbox: &SandboxRunner,
    session: &SandboxSession,
    session_id: &str,
    command: String,
    context: &HarnessRunContext,
    events: &mut HarnessEvents,
) -> Result<String, GatewayError> {
    let mut assistant_text = String::new();
    let mut stream = sandbox.start(session, SandboxCommand { command }).await?;
    while let Some(output) = stream.next().await {
        let output = output?;
        if output.delta.is_empty() {
            continue;
        }
        let output_events = events.output(context, output);
        assistant_text.push_str(&assistant_delta(&output_events));
        push_events(state, session_id, output_events);
    }
    Ok(assistant_text)
}

async fn persist_assistant_message(
    pool: &PgPool,
    session_id: &str,
    context: &HarnessRunContext,
    assistant_text: &str,
) -> Result<(), GatewayError> {
    if assistant_text.is_empty() {
        return Ok(());
    }
    persist_message_with_ids(
        pool,
        session_id,
        "assistant",
        assistant_text,
        Some("stop"),
        Some(&context.message_id),
        Some(&context.part_id),
    )
    .await
}

fn mark_sandbox_running(state: &AppState, row: &SessionRow, session: &SandboxSession) {
    if let Some(sandbox_id) = session.sandbox_id.clone() {
        state.agent_runs.set_sandbox_id(&row.id, sandbox_id);
    }
    state
        .agent_runs
        .update_status(&row.id, AgentRunStatus::Running);
}

fn assistant_delta(events: &[HarnessEvent]) -> String {
    events
        .iter()
        .filter(|event| event.event == events::MESSAGE_PART_DELTA)
        .filter_map(|event| event.data.get("delta").and_then(|delta| delta.as_str()))
        .collect::<Vec<_>>()
        .join("")
}

fn push_events(state: &AppState, session_id: &str, events: Vec<HarnessEvent>) {
    for event in events {
        state
            .agent_runs
            .push_event(session_id, event.event, event.data);
    }
}

async fn agent_definition(
    pool: &PgPool,
    state: &AppState,
    row: &SessionRow,
    model: &str,
) -> Result<AgentDefinition, GatewayError> {
    if let Some(agent_id) = row.agent_id.as_deref() {
        if let Some(agent) = registry::repository::get(pool, agent_id).await? {
            return Ok(managed_agent_definition(agent));
        }
        if let Some(agent) = state
            .config
            .agents
            .iter()
            .find(|agent| agent.id() == agent_id)
        {
            return Ok(agent.clone());
        }
    }

    Ok(AgentDefinition {
        id: Some(row.id.clone()),
        name: row.title.clone(),
        description: None,
        model: model.to_owned(),
        harness: Some(row.harness.clone()),
        system: String::new(),
        mcp_servers: Vec::new(),
        tools: Vec::<HashMap<String, serde_yaml::Value>>::new(),
        skills: Vec::new(),
    })
}

fn managed_agent_definition(agent: ManagedAgentRow) -> AgentDefinition {
    AgentDefinition {
        id: Some(agent.id),
        name: agent.name,
        description: agent.description,
        model: agent.model,
        harness: Some(agent.harness),
        system: agent.system,
        mcp_servers: Vec::new(),
        tools: Vec::<HashMap<String, serde_yaml::Value>>::new(),
        skills: Vec::new(),
    }
}
