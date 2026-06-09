use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, response::IntoResponse, Json};
use serde_json::json;

use crate::{
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

pub async fn capabilities(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    Ok(Json(json!({
        "gateway": "litellm-rust",
        "providers": providers(&state),
        "models": model_ids(&state),
        "endpoints": [
            "/v1/messages",
            "/mcp",
            "/mcp/{server_id}",
            "/api/agents",
            "/api/agents/{agent_id}/run",
            "/api/keys",
            "/api/capabilities",
            "/openapi.json"
        ],
        "mcp_servers": state.config.mcp_servers.keys().collect::<Vec<_>>(),
        "agents": state.config.agents.iter().map(|agent| &agent.id).collect::<Vec<_>>()
    })))
}

fn model_ids(state: &AppState) -> Vec<&str> {
    state
        .config
        .model_list
        .iter()
        .map(|entry| entry.model_name.as_str())
        .collect()
}

fn providers(state: &AppState) -> Vec<&str> {
    state
        .config
        .model_list
        .iter()
        .filter_map(|entry| {
            entry
                .litellm_params
                .model
                .split_once('/')
                .map(|(provider, _)| provider)
        })
        .collect()
}
