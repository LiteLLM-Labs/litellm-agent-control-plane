use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;

use crate::{
    db::managed_agents::harnesses,
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
    sdk::{
        agents::{AgentRuntime, ListModelsParams, ModelInfo, ModelList, CLAUDE_MANAGED_AGENTS},
        providers,
    },
};

const CLAUDE_AGENTS_LEGACY: &str = "claude_agents";

#[derive(Debug, Deserialize)]
pub struct ModelsQuery {
    runtime: Option<String>,
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

    let data = state
        .config
        .model_list
        .iter()
        .map(|entry| ModelInfo {
            id: entry.model_name.clone(),
            object: "model".to_owned(),
            created: 0,
            owned_by: "litellm".to_owned(),
        })
        .collect();

    Ok(Json(ModelList {
        object: "list".to_owned(),
        data,
    }))
}

async fn runtime_models(state: &AppState, alias: &str) -> Result<ModelList, GatewayError> {
    let runtime = runtime_for_alias(state, alias).await?;
    if let Some(pool) = state.db.as_ref() {
        if let Ok(resolved) =
            crate::http::runtime_resolution::resolve_runtime(pool, state, alias).await
        {
            if let Ok(client) = crate::http::sessions::lap_from_credential(&resolved) {
                if let Ok(models) = client
                    .beta()
                    .models()
                    .list(ListModelsParams {
                        lap_agent_runtime: resolved.agent_runtime,
                    })
                    .await
                {
                    return Ok(models);
                }
            }
        }
    }
    Ok(ModelList::from_ids(
        runtime.default_model_ids().iter().copied(),
        alias,
    ))
}

async fn runtime_for_alias(state: &AppState, alias: &str) -> Result<AgentRuntime, GatewayError> {
    let alias = if alias == CLAUDE_AGENTS_LEGACY {
        CLAUDE_MANAGED_AGENTS
    } else {
        alias
    };

    if let Some(entry) = providers::runtime_registry().entry_for_id(alias) {
        return Ok(entry.runtime);
    }

    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let harness = harnesses::repository::get_by_alias(pool, alias)
        .await?
        .ok_or_else(|| GatewayError::InvalidJsonMessage(format!("unsupported runtime: {alias}")))?;
    providers::runtime_registry()
        .entry_for_id(&harness.api_spec)
        .map(|entry| entry.runtime)
        .ok_or_else(|| {
            GatewayError::InvalidConfig(format!("unknown api_spec: {}", harness.api_spec))
        })
}
