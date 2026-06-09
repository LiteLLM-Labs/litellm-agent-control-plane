use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{
    db::managed_agents::registry::repository,
    errors::GatewayError,
    http::agents::configured_agent_value,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

pub async fn get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    if let Some(agent) = configured_agent_value(&state, &agent_id) {
        return Ok(Json(agent));
    }

    let Some(pool) = state.db.as_ref() else {
        return Err(GatewayError::MissingDatabase);
    };
    let row = repository::get(pool, &agent_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("not found".to_owned()))?;
    Ok(Json(serde_json::to_value(row)?))
}
