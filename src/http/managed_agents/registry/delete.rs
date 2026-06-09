use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{
    db::managed_agents::{memory, registry},
    errors::GatewayError,
    proxy::state::AppState,
};

use super::types::DeleteResponse;

pub async fn delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<Json<DeleteResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    if !registry::repository::delete(pool, &agent_id).await? {
        return Err(GatewayError::NotFound("not found".to_owned()));
    }
    memory::repository::delete_all(pool, &agent_id).await?;
    Ok(Json(DeleteResponse { ok: true }))
}
