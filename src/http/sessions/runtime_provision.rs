use std::collections::HashMap;

use serde_json::Value;
use sqlx::PgPool;

use crate::{
    db::managed_agents::{
        runtime_refs::{self, schema::UpsertRuntimeRef},
        sessions::{self, schema::SessionRow},
    },
    errors::GatewayError,
    proxy::state::AppState,
    sdk::agents::{
        AgentModel, AgentModelConfig, AgentRuntime, CreateAgentParams, CreateEnvironmentParams,
        CreateSessionParams, Lap, LapConfig,
    },
};

mod gemini;
mod mcp_vault;

use super::{
    runtime::CreatedRuntimeSession,
    runtime_inputs::{
        agent_metadata, agent_model, mcp_servers, provider_system, session_metadata,
        workspace_from_env,
    },
    runtime_sdk::agent_sdk_error,
};

struct RuntimeProvision {
    runtime_agent_id: String,
    provider_session_id: Option<String>,
    provider_run_id: Option<String>,
    provider_url: Option<String>,
    metadata: Value,
}

pub(super) async fn provision_runtime_session(
    state: &AppState,
    pool: &PgPool,
    created: &CreatedRuntimeSession,
) -> Result<SessionRow, GatewayError> {
    let sdk_rt = created.resolved.agent_runtime;
    let client = runtime_client(state, created);
    let provider_mcp_servers = mcp_servers(state, &created.agent, Some(&created.row.id))?;
    let provider_agent = match gemini::reusable_provider_agent(pool, sdk_rt, created).await? {
        Some(agent) => agent,
        None => {
            create_provider_agent(&client, sdk_rt, created, provider_mcp_servers.clone()).await?
        }
    };
    let provider_env = create_provider_environment(&client, sdk_rt, created).await?;
    let vault_ids = mcp_vault::vault_ids(state, pool, created, &provider_mcp_servers).await?;
    let provider_session = client
        .beta()
        .sessions()
        .create(CreateSessionParams {
            agent: provider_agent.id.clone(),
            environment_id: provider_env.id.clone(),
            title: format!("{} session", created.agent.name),
            lap_agent_runtime: Some(sdk_rt),
            metadata: Some(session_metadata(
                &created.agent,
                &created.row.id,
                &created.prompt,
            )),
            vault_ids,
            resources: None,
        })
        .await
        .map_err(agent_sdk_error)?;
    let provision = runtime_provision(
        created,
        &provider_agent.id,
        provider_session_id(created, &provider_session),
        &provider_agent.raw,
        serde_json::json!({
            "runtime": created.runtime,
            "agent": provider_agent.raw,
            "agent_signature": gemini::provider_agent_signature(created.resolved.agent_runtime, created),
            "environment": provider_env.raw,
            "session": provider_session.raw,
        }),
    );
    persist_runtime_refs(pool, created, provision).await
}

fn provider_session_id(
    created: &CreatedRuntimeSession,
    session: &crate::sdk::agents::Session,
) -> Option<String> {
    created
        .resolved
        .adapter
        .provider_session_id_from_session_raw(&session.raw)
        .or_else(|| Some(session.id.clone()))
}

fn runtime_client(state: &AppState, created: &CreatedRuntimeSession) -> Lap {
    let mut config = LapConfig::default();
    match created.resolved.agent_runtime {
        AgentRuntime::ClaudeManagedAgents => {
            config.anthropic_api_key = Some(created.resolved.credential.api_key.clone());
            config.anthropic_base_url = created.resolved.credential.api_base.clone();
        }
        AgentRuntime::Cursor => {
            config.cursor_api_key = Some(created.resolved.credential.api_key.clone());
            config.cursor_base_url = created.resolved.credential.api_base.clone();
        }
        AgentRuntime::GeminiAntigravity => {
            config.gemini_api_key = Some(created.resolved.credential.api_key.clone());
            config.gemini_base_url = created.resolved.credential.api_base.clone();
        }
        AgentRuntime::ElasticAgentBuilder => {
            config.elastic_api_key = Some(created.resolved.credential.api_key.clone());
            config.elastic_base_url = created.resolved.credential.api_base.clone();
        }
    }
    Lap::with_http_client(config, state.http.clone())
}

async fn create_provider_agent(
    client: &Lap,
    runtime: AgentRuntime,
    created: &CreatedRuntimeSession,
    mcp_servers: Vec<Value>,
) -> Result<crate::sdk::agents::ManagedAgent, GatewayError> {
    client
        .beta()
        .agents()
        .create(CreateAgentParams {
            lap_agent_runtime: runtime,
            lap_provider_options: provider_options(runtime, created),
            name: gemini::provider_agent_name(runtime, created),
            model: AgentModel::Config(AgentModelConfig {
                id: agent_model(&created.agent, &created.environment),
                speed: None,
            }),
            system: provider_system(runtime, created),
            description: created.agent.description.clone(),
            tools: gemini::provider_tools(runtime, created),
            mcp_servers,
            workspace: workspace_from_env(&created.environment)?,
            env_vars: None,
            metadata: Some(agent_metadata(&created.agent)),
        })
        .await
        .map_err(agent_sdk_error)
}

fn attached_vault_env_vars(vault_keys: &Value, environment: &Value) -> HashMap<String, String> {
    vault_keys
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|key| {
            environment
                .get(key)
                .and_then(Value::as_str)
                .map(|value| (key.to_owned(), value.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::attached_vault_env_vars;
    use serde_json::json;

    #[test]
    fn resolves_only_attached_string_vault_values() {
        let keys = json!(["ERAMBA_USERNAME", "ERAMBA_PASSWORD", "MISSING"]);
        let environment = json!({
            "ERAMBA_USERNAME": "agent-user",
            "ERAMBA_PASSWORD": "secret-value",
            "UNATTACHED": "must-not-be-forwarded",
            "MISSING": null
        });

        assert_eq!(
            attached_vault_env_vars(&keys, &environment),
            [
                ("ERAMBA_USERNAME".to_owned(), "agent-user".to_owned()),
                ("ERAMBA_PASSWORD".to_owned(), "secret-value".to_owned()),
            ]
            .into_iter()
            .collect()
        );
    }
}

fn provider_options(runtime: AgentRuntime, created: &CreatedRuntimeSession) -> Option<Value> {
    if created.resolved.alias == "local-deepagents" {
        let env_vars = attached_vault_env_vars(&created.agent.vault_keys, &created.environment);
        return (!env_vars.is_empty()).then(|| serde_json::json!({ "env_vars": env_vars }));
    }
    (runtime == AgentRuntime::ElasticAgentBuilder).then(|| created.agent.config.clone())
}

async fn create_provider_environment(
    client: &Lap,
    runtime: AgentRuntime,
    created: &CreatedRuntimeSession,
) -> Result<crate::sdk::agents::Environment, GatewayError> {
    client
        .beta()
        .environments()
        .create(CreateEnvironmentParams {
            lap_agent_runtime: runtime,
            name: format!("{} environment", created.agent.name),
            config: serde_json::json!({
                "type": "cloud",
                "networking": { "type": "unrestricted" }
            }),
            description: None,
            scope: None,
        })
        .await
        .map_err(agent_sdk_error)
}

fn runtime_provision(
    created: &CreatedRuntimeSession,
    agent_id: &str,
    provider_session_id: Option<String>,
    raw: &Value,
    metadata: Value,
) -> RuntimeProvision {
    let provider_run_id = created.resolved.adapter.provider_run_id_from_agent_raw(raw);
    let provider_url = created.resolved.adapter.provider_url_from_agent_raw(raw);
    RuntimeProvision {
        runtime_agent_id: agent_id.to_owned(),
        provider_session_id,
        provider_run_id,
        provider_url,
        metadata,
    }
}

async fn persist_runtime_refs(
    pool: &PgPool,
    created: &CreatedRuntimeSession,
    provision: RuntimeProvision,
) -> Result<SessionRow, GatewayError> {
    let runtime_ref = runtime_refs::repository::upsert(
        pool,
        &created.agent.id,
        &created.runtime,
        UpsertRuntimeRef {
            runtime_agent_id: provision.runtime_agent_id,
            provider_session_id: provision.provider_session_id.clone(),
            provider_run_id: provision.provider_run_id.clone(),
            provider_url: provision.provider_url,
            metadata: provision.metadata,
        },
    )
    .await?;
    sessions::repository::set_runtime_refs(
        pool,
        &created.row.id,
        &runtime_ref.id,
        provision.provider_session_id.as_deref(),
        provision.provider_run_id.as_deref(),
        "running",
    )
    .await
}
