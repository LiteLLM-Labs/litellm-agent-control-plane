use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{
    db::managed_agents::{files::repository, registry},
    errors::GatewayError,
    proxy::state::AppState,
};

use super::types::FilesResponse;

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<Json<FilesResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    if registry::repository::get(pool, &agent_id).await?.is_none() {
        return Err(GatewayError::NotFound("agent not found".to_owned()));
    }
    Ok(Json(FilesResponse {
        files: repository::list(pool, &agent_id).await?,
    }))
}
