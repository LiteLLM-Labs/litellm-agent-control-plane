mod agent;
mod interaction;
mod stream;

use std::{collections::HashSet, time::Duration};

use async_stream::try_stream;
use futures_util::stream as futures_stream;
use serde_json::{json, Value};

use crate::sdk::agents::{
    response_fields::id, AgentEventStream, AgentRuntime, AgentSdkError, CreateAgentParams,
    CreateEnvironmentParams, CreateSessionParams, DeleteAgentParams, DeleteAgentResponse,
    Environment, GetAgentParams, Lap, ListAgentsParams, ManagedAgent, ManagedAgentList,
    SendEventsParams, SendEventsResponse, Session, SessionContext, GEMINI_ANTIGRAVITY,
};
use crate::sdk::providers::base::runtime::{AdapterFuture, RuntimeAdapter};
use agent::{create_agent_body, list_agents_path, managed_agent};
use interaction::{event_key, gemini_context, interaction_body, interaction_is_terminal};
use stream::{events_from_interaction, list_events_from_interaction};

pub(super) const DEFAULT_ENVIRONMENT_ID: &str = "remote";

pub(crate) const RUNTIME_ID: &str = GEMINI_ANTIGRAVITY;

pub(crate) struct GeminiAntigravityRuntime;

impl RuntimeAdapter for GeminiAntigravityRuntime {
    fn provider_run_id_from_agent_raw(&self, raw: &Value) -> Option<String> {
        (raw.get("object").and_then(Value::as_str) == Some("interaction"))
            .then(|| raw.get("id").and_then(Value::as_str).map(str::to_owned))
            .flatten()
    }

    fn provider_session_id_from_session_raw(&self, raw: &Value) -> Option<String> {
        raw.get("environment_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn events_from_send_response_raw(&self, raw: &Value) -> Vec<Value> {
        list_events_from_interaction(raw)
    }

    fn create_agent<'a>(
        &'a self,
        client: &'a Lap,
        params: CreateAgentParams,
    ) -> AdapterFuture<'a, ManagedAgent> {
        Box::pin(async move {
            let raw = client
                .post(
                    AgentRuntime::GeminiAntigravity,
                    "/v1beta/agents",
                    &create_agent_body(params)?,
                )
                .await?;
            managed_agent(raw)
        })
    }

    fn list_agents<'a>(
        &'a self,
        client: &'a Lap,
        params: ListAgentsParams,
    ) -> AdapterFuture<'a, ManagedAgentList> {
        Box::pin(async move {
            let raw = client
                .get(AgentRuntime::GeminiAntigravity, &list_agents_path(params))
                .await?;
            let agents = raw
                .get("agents")
                .or_else(|| raw.get("data"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(managed_agent)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(ManagedAgentList {
                agents,
                next_page_token: raw
                    .get("next_page_token")
                    .or_else(|| raw.get("nextPageToken"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                raw,
            })
        })
    }

    fn get_agent<'a>(
        &'a self,
        client: &'a Lap,
        params: GetAgentParams,
    ) -> AdapterFuture<'a, ManagedAgent> {
        Box::pin(async move {
            let raw = client
                .get(
                    AgentRuntime::GeminiAntigravity,
                    &format!("/v1beta/agents/{}", params.id),
                )
                .await?;
            managed_agent(raw)
        })
    }

    fn delete_agent<'a>(
        &'a self,
        client: &'a Lap,
        params: DeleteAgentParams,
    ) -> AdapterFuture<'a, DeleteAgentResponse> {
        Box::pin(async move {
            let raw = client
                .delete(
                    AgentRuntime::GeminiAntigravity,
                    &format!("/v1beta/agents/{}", params.id),
                )
                .await?;
            Ok(DeleteAgentResponse { raw })
        })
    }

    fn create_environment<'a>(
        &'a self,
        _client: &'a Lap,
        params: CreateEnvironmentParams,
    ) -> AdapterFuture<'a, Environment> {
        Box::pin(async move {
            let environment = environment_id(params.config);
            let raw = json!({ "id": environment });
            Ok(Environment { id: id(&raw)?, raw })
        })
    }

    fn create_session<'a>(
        &'a self,
        client: &'a Lap,
        params: CreateSessionParams,
    ) -> AdapterFuture<'a, Session> {
        Box::pin(async move {
            if params.agent.trim().is_empty() {
                return Err(AgentSdkError::InvalidRequest(
                    "gemini_antigravity sessions.create requires a non-empty agent id".to_owned(),
                ));
            }
            let environment_id = if params.environment_id.trim().is_empty() {
                DEFAULT_ENVIRONMENT_ID.to_owned()
            } else {
                params.environment_id
            };
            let raw = json!({
                "id": format!("gemini_ses_{}", uuid::Uuid::new_v4().simple()),
                "agent": params.agent,
                "environment_id": environment_id,
                "status": "idle"
            });
            let session = Session {
                id: id(&raw)?,
                agent: raw.get("agent").and_then(Value::as_str).map(str::to_owned),
                environment_id: raw
                    .get("environment_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                status: raw.get("status").and_then(Value::as_str).map(str::to_owned),
                metadata: None,
                created_at: None,
                updated_at: None,
                raw,
            };
            client.remember_session_context(
                &session.id,
                SessionContext::gemini(
                    session.environment_id.clone().unwrap_or_else(|| DEFAULT_ENVIRONMENT_ID.to_owned()),
                    session.agent.clone().unwrap_or_default(),
                    None,
                ),
            )?;
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
            let context = gemini_context(client, session_id)?;
            let raw = client
                .post(
                    AgentRuntime::GeminiAntigravity,
                    "/v1beta/interactions",
                    &interaction_body(&context, &params)?,
                )
                .await?;
            let interaction_id = id(&raw)?;
            client.remember_session_context(
                session_id,
                SessionContext::gemini(
                    context.environment_id,
                    context.agent_id,
                    Some(interaction_id),
                ),
            )?;
            Ok(SendEventsResponse { raw })
        })
    }

    fn stream_events<'a>(
        &'a self,
        client: &'a Lap,
        session_id: &'a str,
    ) -> AdapterFuture<'a, AgentEventStream> {
        Box::pin(async move {
            let context = gemini_context(client, session_id)?;
            let Some(interaction_id) = context.interaction_id else {
                return Ok(Box::pin(futures_stream::empty()) as AgentEventStream);
            };
            let polling_client = client.clone();
            let stream = try_stream! {
                let mut seen = HashSet::new();
                loop {
                    let raw = polling_client
                        .get(
                            AgentRuntime::GeminiAntigravity,
                            &format!("/v1beta/interactions/{interaction_id}"),
                        )
                        .await?;
                    for event in events_from_interaction(&raw) {
                        if seen.insert(event_key(&event)) {
                            yield event;
                        }
                    }
                    if interaction_is_terminal(&raw) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            };
            Ok(Box::pin(stream) as AgentEventStream)
        })
    }

    fn list_events<'a>(
        &'a self,
        client: &'a Lap,
        session_id: &'a str,
    ) -> AdapterFuture<'a, Value> {
        Box::pin(async move {
            let context = gemini_context(client, session_id)?;
            let Some(interaction_id) = context.interaction_id else {
                return Ok(json!({ "data": [] }));
            };
            let raw = client
                .get(
                    AgentRuntime::GeminiAntigravity,
                    &format!("/v1beta/interactions/{interaction_id}"),
                )
                .await?;
            Ok(json!({ "data": list_events_from_interaction(&raw), "raw": raw }))
        })
    }
}

fn environment_id(config: Value) -> String {
    config
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            config
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| DEFAULT_ENVIRONMENT_ID.to_owned())
}
