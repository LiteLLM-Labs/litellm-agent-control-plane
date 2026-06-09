use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};

use crate::{
    db::managed_agents::runs::repository,
    errors::GatewayError,
    http::agents::configured_agent_runs_value,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

use super::types::{ListRunsQuery, RunsResponse};

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Query(query): Query<ListRunsQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    if let Some(runs) = configured_agent_runs_value(&state, &agent_id) {
        return Ok(Json(runs));
    }

    let Some(pool) = state.db.as_ref() else {
        return Err(GatewayError::MissingDatabase);
    };
    Ok(Json(serde_json::to_value(RunsResponse {
        runs: repository::list(pool, &agent_id, query.limit.unwrap_or(10)).await?,
    })?))
}
