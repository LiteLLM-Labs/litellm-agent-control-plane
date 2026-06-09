use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{db::managed_agents::skills::repository, errors::GatewayError, proxy::state::AppState};

use super::types::DeleteResponse;

pub async fn delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(skill_id): Path<String>,
) -> Result<Json<DeleteResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    if !repository::delete(pool, &skill_id).await? {
        return Err(GatewayError::NotFound("not found".to_owned()));
    }
    Ok(Json(DeleteResponse { ok: true }))
}
