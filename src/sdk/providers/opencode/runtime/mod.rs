mod request;
mod stream;

use serde_json::json;

use crate::sdk::agents::{
    response_fields::id,
    AgentEventStream, AgentRuntime, AgentSdkError, CreateAgentParams, CreateEnvironmentParams,
    CreateSessionParams, Environment, Lap, ManagedAgent, SendEventsParams, SendEventsResponse,
    Session, OPENCODE,
};
use crate::sdk::providers::base::runtime::{AdapterFuture, RuntimeAdapter};
use request::{message_body, session_body};
use stream::normalize_opencode_stream;

pub(crate) const RUNTIME_ID: &str = OPENCODE;

pub(crate) struct OpenCodeRuntime;

impl RuntimeAdapter for OpenCodeRuntime {
    fn create_agent<'a>(
        &'a self,
        _client: &'a Lap,
        params: CreateAgentParams,
    ) -> AdapterFuture<'a, ManagedAgent> {
        Box::pin(async move {
            let raw = json!({ "id": params.name });
            Ok(ManagedAgent {
                id: id(&raw)?,
                version: None,
                name: Some(params.name),
                description: None,
                model: None,
                system: None,
                tools: Vec::new(),
                mcp_servers: Vec::new(),
                metadata: None,
                created_at: None,
                updated_at: None,
                raw,
            })
        })
    }

    fn create_environment<'a>(
        &'a self,
        _client: &'a Lap,
        params: CreateEnvironmentParams,
    ) -> AdapterFuture<'a, Environment> {
        Box::pin(async move {
            let raw = json!({ "id": params.name });
            Ok(Environment { id: id(&raw)?, raw })
        })
    }

    fn create_session<'a>(
        &'a self,
        client: &'a Lap,
        params: CreateSessionParams,
    ) -> AdapterFuture<'a, Session> {
        Box::pin(async move {
            let raw = client
                .post(
                    AgentRuntime::OpenCode,
                    "/session",
                    &session_body(params.title, params.resources),
                )
                .await?;
            let session = Session {
                id: id(&raw)?,
                agent: None,
                environment_id: None,
                status: None,
                metadata: None,
                created_at: None,
                updated_at: None,
                raw,
            };
            client.remember_session(&session.id, AgentRuntime::OpenCode)?;
            Ok(session)
        })
    }

    fn send_events<'a>(
        &'a self,
        client: &'a Lap,
        session_id: &'a str,
        params: SendEventsParams,
    ) -> AdapterFuture<'a, SendEventsResponse> {
        Box::pin(async move {
            let provider_session_id = provider_session_id(client, session_id)?;
            let raw = client
                .post(
                    AgentRuntime::OpenCode,
                    &format!("/session/{provider_session_id}/message"),
                    &message_body(&params)?,
                )
                .await?;
            Ok(SendEventsResponse { raw })
        })
    }

    fn stream_events<'a>(
        &'a self,
        client: &'a Lap,
        session_id: &'a str,
    ) -> AdapterFuture<'a, AgentEventStream> {
        Box::pin(async move {
            let provider_session_id = provider_session_id(client, session_id)?;
            let stream = client.stream(AgentRuntime::OpenCode, "/event").await?;
            Ok(normalize_opencode_stream(provider_session_id, stream))
        })
    }

    fn interrupt_session<'a>(
        &'a self,
        client: &'a Lap,
        session_id: &'a str,
    ) -> AdapterFuture<'a, ()> {
        Box::pin(async move {
            let provider_session_id = provider_session_id(client, session_id)?;
            client
                .post(
                    AgentRuntime::OpenCode,
                    &format!("/session/{provider_session_id}/abort"),
                    &serde_json::json!({}),
                )
                .await?;
            Ok(())
        })
    }
}

fn provider_session_id(client: &Lap, session_id: &str) -> Result<String, AgentSdkError> {
    Ok(client
        .context_for_session(session_id)?
        .and_then(|context| context.provider_session_id)
        .unwrap_or_else(|| session_id.to_owned()))
}
