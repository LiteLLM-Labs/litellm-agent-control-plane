use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{
    db::managed_agents::{memory::repository, registry},
    errors::GatewayError,
    proxy::state::AppState,
};

use super::types::MemoriesResponse;

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<Json<MemoriesResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    if registry::repository::get(pool, &agent_id).await?.is_none() {
        return Err(GatewayError::NotFound("not found".to_owned()));
    }
    Ok(Json(MemoriesResponse {
        memories: repository::list(pool, &agent_id).await?,
    }))
}
