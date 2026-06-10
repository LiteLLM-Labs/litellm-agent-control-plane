use std::{collections::HashSet, sync::Arc};

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;

use crate::{
    db::managed_agents::harnesses,
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, config::ModelEntry, state::AppState},
    sdk::{
        agents::{AgentRuntime, AgentSdkError, ListModelsParams, ModelInfo, ModelList},
        providers,
    },
};

#[derive(Debug, Deserialize)]
pub struct ModelsQuery {
    runtime: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ConfiguredModel {
    pub id: String,
    pub provider_id: String,
    pub source: String,
    pub source_detail: String,
    pub configured_model: String,
}

pub async fn models(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ModelsQuery>,
) -> Result<Json<ModelList>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;

    if let Some(runtime) = query
        .runtime
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return Ok(Json(runtime_models(&state, runtime).await?));
    }

    let data = configured_model_infos(&state)?;

    Ok(Json(ModelList {
        object: "list".to_owned(),
        data,
    }))
}

fn configured_model_infos(state: &AppState) -> Result<Vec<ModelInfo>, GatewayError> {
    Ok(configured_models(state)?
        .into_iter()
        .map(|model| ModelInfo {
            id: model.id,
            object: "model".to_owned(),
            created: 0,
            owned_by: model.provider_id,
        })
        .collect())
}

pub(crate) fn configured_models(state: &AppState) -> Result<Vec<ConfiguredModel>, GatewayError> {
    let mut data = Vec::new();
    let mut seen = HashSet::new();

    for entry in &state.config.model_list {
        let (provider_id, upstream_model) = configured_provider_model(entry)?;

        if entry.model_name.trim().ends_with("/*") && upstream_model == "*" {
            for model_id in provider_catalog_models(state, provider_id) {
                push_model(
                    &mut data,
                    &mut seen,
                    model_id,
                    provider_id,
                    &entry.model_name,
                    format!("expanded from {}", entry.model_name.trim()),
                );
            }
            continue;
        }

        push_model(
            &mut data,
            &mut seen,
            entry.model_name.clone(),
            provider_id,
            &entry.model_name,
            "model_list entry".to_owned(),
        );
    }

    Ok(data)
}

async fn runtime_models(state: &AppState, alias: &str) -> Result<ModelList, GatewayError> {
    let runtime = runtime_for_alias(state, alias).await?;
    if providers::model_endpoint(runtime).is_none() {
        return Err(GatewayError::InvalidJsonMessage(format!(
            "model discovery is not supported for runtime: {alias}"
        )));
    }
    if let Some(pool) = state.db.as_ref() {
        let resolved = crate::http::runtime_resolution::resolve_runtime(pool, state, alias).await?;
        let client = crate::http::sessions::lap_from_credential(&resolved)?;
        return client
            .beta()
            .models()
            .list(ListModelsParams {
                lap_agent_runtime: resolved.agent_runtime,
            })
            .await
            .map_err(model_discovery_error);
    }
    Err(GatewayError::MissingDatabase)
}

async fn runtime_for_alias(state: &AppState, alias: &str) -> Result<AgentRuntime, GatewayError> {
    let model_registry = providers::model_registry();
    if let Some(entry) = model_registry.entry_for_id(alias) {
        return Ok(entry.runtime);
    }

    let runtime_registry = providers::runtime_registry();
    if let Some(entry) = runtime_registry.entry_for_id(alias) {
        return Ok(entry.runtime);
    }

    let Some(pool) = state.db.as_ref() else {
        return Err(GatewayError::InvalidJsonMessage(format!(
            "unsupported runtime: {alias}"
        )));
    };
    let harness = harnesses::repository::get_by_alias(pool, alias)
        .await?
        .ok_or_else(|| GatewayError::InvalidJsonMessage(format!("unsupported runtime: {alias}")))?;
    if let Some(entry) = model_registry.entry_for_id(&harness.api_spec) {
        return Ok(entry.runtime);
    }

    runtime_registry
        .entry_for_id(&harness.api_spec)
        .map(|entry| entry.runtime)
        .ok_or_else(|| {
            GatewayError::InvalidConfig(format!("unknown api_spec: {}", harness.api_spec))
        })
}

fn configured_provider_model(entry: &ModelEntry) -> Result<(&str, &str), GatewayError> {
    let model = entry.litellm_params.model.trim();
    let Some((provider_id, upstream_model)) = model.split_once('/') else {
        return Err(GatewayError::InvalidConfig(format!(
            "model must include provider prefix (e.g. anthropic/...), got {model}"
        )));
    };
    let provider_id = provider_id.trim();
    let upstream_model = upstream_model.trim();
    if provider_id.is_empty() || upstream_model.is_empty() {
        return Err(GatewayError::InvalidConfig(format!(
            "model must include provider prefix and model name, got {model}"
        )));
    }
    Ok((provider_id, upstream_model))
}

fn provider_catalog_models(state: &AppState, provider_id: &str) -> Vec<String> {
    let mut models = state
        .model_cost_map
        .iter()
        .filter(|(_, info)| info.litellm_provider.as_deref() == Some(provider_id))
        .map(|(model_id, _)| model_id.clone())
        .collect::<Vec<_>>();
    models.sort();
    models
}

fn push_model(
    data: &mut Vec<ConfiguredModel>,
    seen: &mut HashSet<String>,
    model_id: String,
    provider_id: &str,
    configured_model: &str,
    source_detail: String,
) {
    let model_id = model_id.trim();
    if model_id.is_empty() || !seen.insert(model_id.to_owned()) {
        return;
    }
    data.push(ConfiguredModel {
        id: model_id.to_owned(),
        provider_id: provider_id.to_owned(),
        source: "config.yaml".to_owned(),
        source_detail,
        configured_model: configured_model.trim().to_owned(),
    });
}

fn model_discovery_error(error: AgentSdkError) -> GatewayError {
    match error {
        AgentSdkError::Provider { status, body } => GatewayError::SandboxError(format!(
            "managed agent provider request failed with status {status}: {body}"
        )),
        other => GatewayError::SandboxError(other.to_string()),
    }
}
