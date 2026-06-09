use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{db::managed_agents::files::repository, errors::GatewayError, proxy::state::AppState};

use super::types::DeleteResponse;

pub async fn delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((agent_id, path)): Path<(String, String)>,
) -> Result<Json<DeleteResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    repository::delete(pool, &agent_id, &path).await?;
    Ok(Json(DeleteResponse { ok: true }))
}
