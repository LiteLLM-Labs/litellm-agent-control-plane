use std::sync::Arc;

use sqlx::PgPool;
use tracing::warn;

use crate::{
    db::managed_agents::registry::schema::ManagedAgentRow,
    errors::GatewayError,
    http::sessions::{enqueue_prompt_text, runtime_event_stream_for_session},
    proxy::state::AppState,
};

use super::{
    config::load_app_password,
    reply_lock::TeamsPromptLock,
    reply_stream::TeamsReply,
    storage::last_message_seq,
    types::{TeamsAgentConfig, TeamsIncomingMessage},
    web_api,
};

pub(crate) fn spawn_teams_prompt(
    state: Arc<AppState>,
    pool: PgPool,
    agent: ManagedAgentRow,
    config: TeamsAgentConfig,
    message: TeamsIncomingMessage,
    session_id: String,
) {
    tokio::spawn(async move {
        if let Err(error) = run_teams_prompt(state, pool, agent, config, message, session_id).await
        {
            warn!("teams prompt failed: {error}");
        }
    });
}

async fn run_teams_prompt(
    state: Arc<AppState>,
    pool: PgPool,
    agent: ManagedAgentRow,
    config: TeamsAgentConfig,
    message: TeamsIncomingMessage,
    session_id: String,
) -> Result<(), GatewayError> {
    let app_id = app_id(&config)?;
    let app_password = load_app_password(&state, &agent.id, &config).await?;
    let token = web_api::access_token(
        &state.http,
        app_id,
        &app_password,
        config.tenant_id.as_deref(),
    )
    .await?;
    let _lock = TeamsPromptLock::acquire(&state.keyed_locks, &session_id).await;
    let baseline_seq = last_message_seq(&pool, &session_id).await?;
    let runtime_stream = runtime_event_stream_for_session(&state, &pool, &session_id)
        .await
        .ok();
    let event_stream = state.agent_runs.event_stream();
    let placeholder = post_placeholder(&state, &token, &message, &agent.name).await;
    let mut reply = TeamsReply::new(
        &state,
        &pool,
        &token,
        &message,
        &session_id,
        baseline_seq,
        placeholder,
    );
    enqueue_or_report(
        state.clone(),
        &pool,
        &message,
        &mut reply,
        &session_id,
        &agent,
    )
    .await?;
    if let Some(stream) = runtime_stream {
        reply.run_runtime(stream).await
    } else {
        reply.run(event_stream.rx).await
    }
}

fn app_id(config: &TeamsAgentConfig) -> Result<&str, GatewayError> {
    config
        .app_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| GatewayError::InvalidConfig("teams app_id is not configured".to_owned()))
}

async fn post_placeholder(
    state: &AppState,
    token: &str,
    message: &TeamsIncomingMessage,
    username: &str,
) -> Option<String> {
    let text = format!("{username} is thinking...");
    match web_api::post_reply(web_api::SendActivityParams {
        client: &state.http,
        service_url: &message.service_url,
        token,
        conversation_id: &message.conversation_id,
        reply_to_id: &message.activity_id,
        text: &text,
        tenant_id: message.tenant_id.as_deref(),
        from: message.recipient.as_ref(),
        recipient: message.from.as_ref(),
    })
    .await
    {
        Ok(id) => Some(id),
        Err(error) => {
            warn!("teams placeholder failed: {error}");
            None
        }
    }
}

async fn enqueue_or_report(
    state: Arc<AppState>,
    pool: &PgPool,
    message: &TeamsIncomingMessage,
    reply: &mut TeamsReply<'_>,
    session_id: &str,
    agent: &ManagedAgentRow,
) -> Result<(), GatewayError> {
    let result = enqueue_prompt_text(
        state,
        pool.clone(),
        session_id,
        message.prompt.clone(),
        agent.model.clone(),
    )
    .await;
    if let Err(error) = result {
        reply.replace_text(&error.to_string()).await?;
        return Err(error);
    }
    Ok(())
}
