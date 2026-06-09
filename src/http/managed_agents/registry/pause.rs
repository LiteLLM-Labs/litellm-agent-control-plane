use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{
    db::managed_agents::registry::repository, errors::GatewayError, proxy::state::AppState,
};

use super::types::AgentStatusResponse;

pub async fn pause(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<Json<AgentStatusResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    repository::set_status(pool, &agent_id, "paused")
        .await?
        .ok_or_else(|| GatewayError::NotFound("not found".to_owned()))?;
    Ok(Json(AgentStatusResponse {
        id: agent_id,
        status: "paused".to_owned(),
    }))
}
