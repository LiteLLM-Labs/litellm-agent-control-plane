use serde_json::Value;

use crate::sdk::agents::{
    response_fields::id, AgentEventStream, AgentRuntime, AgentSdkError, CreateAgentParams,
    CreateEnvironmentParams, CreateSessionParams, Environment, Lap, ManagedAgent,
    SendEventsParams, SendEventsResponse, Session, CLAUDE_MANAGED_AGENTS,
};
use crate::sdk::providers::base::runtime::{AdapterFuture, RuntimeAdapter};

/// String ID used to identify this runtime in the database and HTTP API.
pub(crate) const RUNTIME_ID: &str = CLAUDE_MANAGED_AGENTS;

pub(crate) struct ClaudeManagedAgentsRuntime;

impl RuntimeAdapter for ClaudeManagedAgentsRuntime {
    fn create_agent<'a>(
        &'a self,
        client: &'a Lap,
        params: CreateAgentParams,
    ) -> AdapterFuture<'a, ManagedAgent> {
        Box::pin(async move {
            let raw = client
                .post(
                    AgentRuntime::ClaudeManagedAgents,
                    "/v1/agents",
                    &create_agent_body(params)?,
                )
                .await?;
            Ok(ManagedAgent {
                id: id(&raw)?,
                version: raw.get("version").and_then(Value::as_u64),
                name: raw.get("name").and_then(Value::as_str).map(str::to_owned),
                description: raw.get("description").and_then(Value::as_str).map(str::to_owned),
                model: raw.get("model").and_then(|m| m.get("id")).and_then(Value::as_str)
                    .or_else(|| raw.get("model").and_then(Value::as_str))
                    .map(str::to_owned),
                system: raw.get("system").and_then(Value::as_str).map(str::to_owned),
                tools: raw.get("tools").and_then(Value::as_array).cloned().unwrap_or_default(),
                mcp_servers: raw.get("mcp_servers").and_then(Value::as_array).cloned().unwrap_or_default(),
                metadata: raw.get("metadata").cloned(),
                created_at: raw.get("created_at").and_then(Value::as_i64),
                updated_at: raw.get("updated_at").and_then(Value::as_i64),
                raw,
            })
        })
    }

    fn create_environment<'a>(
        &'a self,
        client: &'a Lap,
        params: CreateEnvironmentParams,
    ) -> AdapterFuture<'a, Environment> {
        Box::pin(async move {
            let raw = client
                .post(
                    AgentRuntime::ClaudeManagedAgents,
                    "/v1/environments",
                    &params,
                )
                .await?;
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
                .post(AgentRuntime::ClaudeManagedAgents, "/v1/sessions", &params)
                .await?;
            let session = Session {
                id: id(&raw)?,
                agent: raw.get("agent").and_then(Value::as_str).map(str::to_owned),
                environment_id: raw.get("environment_id").and_then(Value::as_str).map(str::to_owned),
                status: raw.get("status").and_then(Value::as_str).map(str::to_owned),
                metadata: raw.get("metadata").cloned(),
                created_at: raw.get("created_at").and_then(Value::as_i64),
                updated_at: raw.get("updated_at").and_then(Value::as_i64),
                raw,
            };
            client.remember_session(&session.id, AgentRuntime::ClaudeManagedAgents)?;
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
                    AgentRuntime::ClaudeManagedAgents,
                    &format!("/v1/sessions/{provider_session_id}/events"),
                    &params,
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
            client
                .stream(
                    AgentRuntime::ClaudeManagedAgents,
                    &format!("/v1/sessions/{provider_session_id}/events/stream"),
                )
                .await
        })
    }

    fn list_events<'a>(
        &'a self,
        client: &'a Lap,
        session_id: &'a str,
    ) -> AdapterFuture<'a, serde_json::Value> {
        Box::pin(async move {
            let provider_session_id = provider_session_id(client, session_id)?;
            client
                .get(
                    AgentRuntime::ClaudeManagedAgents,
                    &format!("/v1/sessions/{provider_session_id}/events"),
                )
                .await
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
                    AgentRuntime::ClaudeManagedAgents,
                    &format!("/v1/sessions/{provider_session_id}/events"),
                    &SendEventsParams {
                        events: vec![serde_json::json!({ "type": "user.interrupt" })],
                    },
                )
                .await?;
            Ok(())
        })
    }
}

fn create_agent_body(params: CreateAgentParams) -> Result<Value, AgentSdkError> {
    let options = params.lap_provider_options.clone();
    let metadata = params.metadata.clone();
    let mut body = serde_json::to_value(params)?;
    if let Some(metadata) = metadata {
        if let Some(body) = body.as_object_mut() {
            body.insert("metadata".to_owned(), serde_json::to_value(metadata)?);
        }
    }
    if let Some(Value::Object(options)) = options {
        let Some(body) = body.as_object_mut() else {
            return Ok(body);
        };
        for (key, value) in options {
            body.insert(key, value);
        }
    }
    Ok(body)
}

fn provider_session_id(client: &Lap, session_id: &str) -> Result<String, AgentSdkError> {
    Ok(client
        .context_for_session(session_id)?
        .and_then(|context| context.provider_session_id)
        .unwrap_or_else(|| session_id.to_owned()))
}
