use std::sync::Arc;

use sqlx::PgPool;
use tracing::warn;

use crate::{
    db::managed_agents::{google_chat, registry::schema::ManagedAgentRow},
    errors::GatewayError,
    http::sessions::{enqueue_prompt_text, runtime_event_stream_for_session},
    proxy::state::AppState,
};

use super::{
    config::load_service_account_json,
    reply_lock::GoogleChatPromptLock,
    reply_stream::GoogleChatReply,
    storage::last_message_seq,
    types::{GoogleChatAgentConfig, GoogleChatIncomingMessage},
    web_api,
};

pub(crate) fn spawn_google_chat_prompt(
    state: Arc<AppState>,
    pool: PgPool,
    agent: ManagedAgentRow,
    config: GoogleChatAgentConfig,
    message: GoogleChatIncomingMessage,
    session_id: String,
) {
    tokio::spawn(async move {
        if let Err(error) =
            run_google_chat_prompt(state, pool, agent, config, message, session_id).await
        {
            warn!("google chat prompt failed: {error}");
        }
    });
}

async fn run_google_chat_prompt(
    state: Arc<AppState>,
    pool: PgPool,
    agent: ManagedAgentRow,
    config: GoogleChatAgentConfig,
    message: GoogleChatIncomingMessage,
    session_id: String,
) -> Result<(), GatewayError> {
    let service_account_json = match load_service_account_json(&state, &agent.id, &config).await {
        Ok(value) => value,
        Err(error) => return fail_claim(&pool, &agent, &message, error).await,
    };
    let token = match web_api::access_token(&state.http, &service_account_json).await {
        Ok(value) => value,
        Err(error) => return fail_claim(&pool, &agent, &message, error).await,
    };
    let _lock = GoogleChatPromptLock::acquire(&state.keyed_locks, &session_id).await;
    let baseline_seq = match last_message_seq(&pool, &session_id).await {
        Ok(value) => value,
        Err(error) => return fail_claim(&pool, &agent, &message, error).await,
    };
    let runtime_stream = runtime_event_stream_for_session(&state, &pool, &session_id)
        .await
        .ok();
    let event_stream = state.agent_runs.event_stream();
    let placeholder = post_placeholder(&state, &token, &message, &agent.name).await;
    let mut reply = GoogleChatReply::new(
        &state,
        &pool,
        &token,
        &message,
        &session_id,
        baseline_seq,
        placeholder,
    );
    if let Err(error) = enqueue_or_report(
        state.clone(),
        &pool,
        &message,
        &mut reply,
        &session_id,
        &agent,
    )
    .await
    {
        return fail_claim(&pool, &agent, &message, error).await;
    }
    google_chat::repository::complete_event(&pool, &agent.id, &message.message_name).await?;
    if let Some(stream) = runtime_stream {
        reply.run_runtime(stream).await
    } else {
        reply.run(event_stream.rx).await
    }
}

async fn fail_claim(
    pool: &PgPool,
    agent: &ManagedAgentRow,
    message: &GoogleChatIncomingMessage,
    error: GatewayError,
) -> Result<(), GatewayError> {
    google_chat::repository::fail_event(pool, &agent.id, &message.message_name).await;
    Err(error)
}

async fn post_placeholder(
    state: &AppState,
    token: &str,
    message: &GoogleChatIncomingMessage,
    agent_name: &str,
) -> Option<String> {
    let text = format!("{agent_name} is thinking...");
    match web_api::create_message(
        &state.http,
        token,
        &message.space_name,
        message.thread_name.as_deref(),
        &text,
    )
    .await
    {
        Ok(name) => Some(name),
        Err(error) => {
            warn!("google chat placeholder failed: {error}");
            None
        }
    }
}

async fn enqueue_or_report(
    state: Arc<AppState>,
    pool: &PgPool,
    message: &GoogleChatIncomingMessage,
    reply: &mut GoogleChatReply<'_>,
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
