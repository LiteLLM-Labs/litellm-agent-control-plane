use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::{json, Value};

use crate::{
    db::{
        credentials,
        managed_agents::registry::{repository, schema::CreateManagedAgent},
    },
    errors::GatewayError,
    http::managed_agents::import_types::{
        provider_error, CredentialMode, DiscoverAgentsRequest, DiscoverAgentsResponse,
        ExternalAgent, ImportAgent, ImportAgentsRequest, ImportAgentsResponse,
        ImportProviderResponse,
    },
    proxy::{auth::master_key::require_any_gateway_key, credential_crypto, state::AppState},
    sdk::providers::{
        elastic::import_agents::ELASTIC_IMPORT_AGENTS, import_agents::ImportAgentsProvider,
    },
};

pub async fn discover(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
    Json(input): Json<DiscoverAgentsRequest>,
) -> Result<Json<DiscoverAgentsResponse>, GatewayError> {
    require_any_gateway_key(&headers, &state).await?;
    let provider = provider_for_id(&provider_id)?;
    let endpoint = normalize_endpoint(&input.endpoint)?;
    let agents = provider
        .discover(&state.http, &endpoint, input.api_key.trim())
        .await
        .map_err(provider_error)?
        .into_iter()
        .map(ExternalAgent::from)
        .collect();
    Ok(Json(DiscoverAgentsResponse { agents }))
}

pub async fn import(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
    Json(input): Json<ImportAgentsRequest>,
) -> Result<(StatusCode, Json<ImportAgentsResponse>), GatewayError> {
    require_any_gateway_key(&headers, &state).await?;
    if input.agents.is_empty() {
        return Err(GatewayError::InvalidJsonMessage(
            "at least one agent is required".to_owned(),
        ));
    }
    let provider = provider_for_id(&provider_id)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let endpoint = normalize_endpoint(&input.endpoint)?;
    let owner_id = owner_id(&input).to_owned();
    let api_key = input.api_key.as_deref().map(str::trim);
    let credential_mode = input.credential_mode;

    let mut rows = Vec::with_capacity(input.agents.len());
    for agent in input.agents {
        rows.push(
            repository::create(
                pool,
                create_input(
                    &state,
                    provider,
                    &endpoint,
                    &owner_id,
                    &credential_mode,
                    api_key,
                    agent,
                )
                .await?,
            )
            .await?,
        );
    }

    Ok((
        StatusCode::CREATED,
        Json(ImportAgentsResponse { agents: rows }),
    ))
}

pub(crate) fn import_runtime_providers() -> Vec<ImportProviderResponse> {
    provider_registry()
        .into_iter()
        .map(|provider| ImportProviderResponse {
            id: provider.id(),
            name: provider.name(),
            api_spec: provider.api_spec(),
        })
        .collect()
}

fn provider_registry() -> Vec<&'static dyn ImportAgentsProvider> {
    vec![&ELASTIC_IMPORT_AGENTS]
}

fn provider_for_id(provider_id: &str) -> Result<&'static dyn ImportAgentsProvider, GatewayError> {
    provider_registry()
        .into_iter()
        .find(|provider| provider.id() == provider_id || provider.api_spec() == provider_id)
        .ok_or_else(|| GatewayError::NotFound(format!("import provider not found: {provider_id}")))
}

async fn create_input(
    state: &AppState,
    provider: &dyn ImportAgentsProvider,
    endpoint: &str,
    owner_id: &str,
    credential_mode: &CredentialMode,
    api_key: Option<&str>,
    agent: ImportAgent,
) -> Result<CreateManagedAgent, GatewayError> {
    let credential_name =
        credential_name_for_agent(state, provider, endpoint, credential_mode, api_key, &agent)
            .await?;
    let system = provider.system_prompt(&agent.external_id);
    Ok(CreateManagedAgent {
        name: agent_name(&agent).to_owned(),
        owner_id: owner_id.to_owned(),
        description: agent.description.clone(),
        runtime: Some(provider.api_spec().to_owned()),
        harness: Some("claude-code".to_owned()),
        prompt: Some(system.clone()),
        tools: Some(json!([])),
        schedule: None,
        vault_keys: Some(json!([])),
        setup_commands: Some(json!([])),
        max_runtime_minutes: Some(30),
        on_failure: Some("pause_and_notify".to_owned()),
        config: Some(agent_config(
            provider,
            endpoint,
            &agent,
            credential_mode,
            credential_name,
        )),
        model: Some(provider.default_model(agent.model.as_deref())),
        system: Some(system),
        skill_ids: Some(json!([])),
        rule_ids: Some(json!([])),
    })
}

async fn credential_name_for_agent(
    state: &AppState,
    provider: &dyn ImportAgentsProvider,
    endpoint: &str,
    credential_mode: &CredentialMode,
    api_key: Option<&str>,
    agent: &ImportAgent,
) -> Result<Option<String>, GatewayError> {
    if !matches!(credential_mode, CredentialMode::Shared) {
        return Ok(None);
    }
    let api_key = shared_api_key(api_key)?;
    let credential_name = provider_credential_name(provider.id(), &agent.external_id);
    save_provider_credential(state, provider, &credential_name, endpoint, api_key).await?;
    Ok(Some(credential_name))
}

fn shared_api_key(api_key: Option<&str>) -> Result<&str, GatewayError> {
    api_key.filter(|value| !value.is_empty()).ok_or_else(|| {
        GatewayError::InvalidJsonMessage("api_key is required for shared credentials".to_owned())
    })
}

fn owner_id(input: &ImportAgentsRequest) -> &str {
    input
        .owner_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("internal")
}

fn agent_name(agent: &ImportAgent) -> &str {
    agent
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(agent.external_id.as_str())
}

fn agent_config(
    provider: &dyn ImportAgentsProvider,
    endpoint: &str,
    agent: &ImportAgent,
    credential_mode: &CredentialMode,
    credential_name: Option<String>,
) -> Value {
    let mut config = json!({
        "runtime": provider.api_spec(),
        "source": source_config(provider, endpoint, agent, credential_mode, credential_name),
    });
    if provider.api_spec() == "elastic_agent_builder" {
        config["elastic_agent_id"] = agent.external_id.clone().into();
    }
    config
}

fn source_config(
    provider: &dyn ImportAgentsProvider,
    endpoint: &str,
    agent: &ImportAgent,
    credential_mode: &CredentialMode,
    credential_name: Option<String>,
) -> Value {
    json!({
        "provider": provider.id(),
        "api_spec": provider.api_spec(),
        "endpoint": endpoint,
        "external_agent_id": agent.external_id,
        "credential_mode": credential_mode.as_str(),
        "credential_name": credential_name,
        "raw": agent.raw.clone().unwrap_or_else(|| json!({}))
    })
}

fn credential_info(provider: &dyn ImportAgentsProvider) -> Value {
    json!({
        "custom_llm_provider": provider.id(),
        "source": "agent-import",
        "api_spec": provider.api_spec(),
    })
}

fn normalize_endpoint(endpoint: &str) -> Result<String, GatewayError> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(GatewayError::InvalidJsonMessage(
            "endpoint is required".to_owned(),
        ));
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| GatewayError::InvalidJsonMessage("endpoint must be a valid URL".to_owned()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(GatewayError::InvalidJsonMessage(
            "endpoint must use http or https".to_owned(),
        ));
    }
    Ok(trimmed.to_owned())
}

fn provider_credential_name(provider_id: &str, external_agent_id: &str) -> String {
    format!("provider:{provider_id}:agent:{external_agent_id}")
}

async fn save_provider_credential(
    state: &AppState,
    provider: &dyn ImportAgentsProvider,
    credential_name: &str,
    endpoint: &str,
    api_key: &str,
) -> Result<(), GatewayError> {
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    credentials::upsert(
        pool,
        credential_name,
        json!({
            "api_key": credential_crypto::encrypt_value(api_key, &key)?,
            "api_base": credential_crypto::encrypt_value(endpoint, &key)?,
        }),
        credential_info(provider),
        "agent-import",
    )
    .await
}

#[cfg(test)]
#[path = "import_tests.rs"]
mod tests;
