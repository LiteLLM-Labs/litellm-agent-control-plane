use std::sync::Arc;

use futures_util::StreamExt;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    agents::{
        config::AgentDefinition,
        events,
        harnesses::{build_harness_run, HarnessEvent, HarnessEvents, HarnessRunContext},
        runs::{event_line, AgentRunStatus},
        sandboxes::{SandboxCommand, SandboxRunner, SandboxSession},
    },
    db::managed_agents::runs::repository,
    errors::GatewayError,
    proxy::state::AppState,
};

pub fn spawn_managed_agent_run(
    state: Arc<AppState>,
    pool: PgPool,
    agent_id: String,
    agent: AgentDefinition,
    prompt: String,
    run_id: String,
) {
    tokio::spawn(async move {
        if let Err(error) =
            execute_managed_agent_run(state.clone(), &pool, &agent_id, agent, prompt, &run_id).await
        {
            let message = error.to_string();
            state.agent_runs.set_error(&run_id, message.clone());
            let _ = repository::fail(&pool, &run_id, &message).await;
            let _ = emit_events(
                &state,
                &pool,
                &agent_id,
                &run_id,
                vec![
                    HarnessEvent::new(
                        events::SESSION_ERROR,
                        json!({ "error": { "message": message } }),
                    ),
                    HarnessEvent::new(events::SESSION_IDLE, json!({ "sessionID": run_id })),
                ],
            )
            .await;
        }
    });
}

async fn execute_managed_agent_run(
    state: Arc<AppState>,
    pool: &PgPool,
    agent_id: &str,
    agent: AgentDefinition,
    prompt: String,
    run_id: &str,
) -> Result<(), GatewayError> {
    let mut harness_run = build_harness_run(&agent, &prompt)?;
    let context = HarnessRunContext::new(run_id);
    emit_events(
        &state,
        pool,
        agent_id,
        run_id,
        harness_run.events.start(&context),
    )
    .await?;

    let sandbox = SandboxRunner::from_settings(state.http.clone(), &state.config.general_settings)?;
    let session = sandbox.create(run_id).await?;
    mark_run_running(&state, pool, run_id, &session).await?;
    let run_result = stream_run_output(RunOutput {
        state: &state,
        pool,
        agent_id,
        run_id,
        sandbox: &sandbox,
        session: &session,
        command: harness_run.command,
        context: &context,
        events: &mut harness_run.events,
    })
    .await;
    let _ = sandbox.terminate(&session).await;
    run_result?;
    finish_run(
        &state,
        pool,
        agent_id,
        run_id,
        &context,
        &harness_run.events,
    )
    .await
}

async fn mark_run_running(
    state: &AppState,
    pool: &PgPool,
    run_id: &str,
    session: &SandboxSession,
) -> Result<(), GatewayError> {
    if let Some(sandbox_id) = session.sandbox_id.clone() {
        state.agent_runs.set_sandbox_id(run_id, sandbox_id.clone());
        repository::set_running(pool, run_id, Some(&sandbox_id)).await?;
    } else {
        repository::set_running(pool, run_id, None).await?;
    }
    state
        .agent_runs
        .update_status(run_id, AgentRunStatus::Running);
    Ok(())
}

struct RunOutput<'a> {
    state: &'a AppState,
    pool: &'a PgPool,
    agent_id: &'a str,
    run_id: &'a str,
    sandbox: &'a SandboxRunner,
    session: &'a SandboxSession,
    command: String,
    context: &'a HarnessRunContext,
    events: &'a mut HarnessEvents,
}

async fn stream_run_output(input: RunOutput<'_>) -> Result<(), GatewayError> {
    let mut stream = input
        .sandbox
        .start(
            input.session,
            SandboxCommand {
                command: input.command,
            },
        )
        .await?;
    while let Some(output) = stream.next().await {
        let output = output?;
        if output.delta.is_empty() {
            continue;
        }
        emit_events(
            input.state,
            input.pool,
            input.agent_id,
            input.run_id,
            input.events.output(input.context, output),
        )
        .await?;
    }
    Ok(())
}

async fn finish_run(
    state: &AppState,
    pool: &PgPool,
    agent_id: &str,
    run_id: &str,
    context: &HarnessRunContext,
    events: &HarnessEvents,
) -> Result<(), GatewayError> {
    state
        .agent_runs
        .update_status(run_id, AgentRunStatus::Completed);
    repository::complete(pool, run_id).await?;
    emit_events(state, pool, agent_id, run_id, events.complete(context)).await
}

async fn emit_events(
    state: &AppState,
    pool: &PgPool,
    agent_id: &str,
    run_id: &str,
    events: Vec<HarnessEvent>,
) -> Result<(), GatewayError> {
    for event in events {
        let properties = event_properties(agent_id, run_id, event.data.clone());
        if let Some(line) = event_line(event.event, properties) {
            repository::append_logs(pool, run_id, &line).await?;
        }
        state.agent_runs.push_event(run_id, event.event, event.data);
    }
    Ok(())
}

fn event_properties(agent_id: &str, run_id: &str, mut data: Value) -> Value {
    if let Some(payload) = data.as_object_mut() {
        payload.insert("agent_id".to_owned(), agent_id.to_owned().into());
        payload.insert("run_id".to_owned(), run_id.to_owned().into());
        payload.insert("sessionID".to_owned(), run_id.to_owned().into());
    }
    data
}
