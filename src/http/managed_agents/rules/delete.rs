use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{db::managed_agents::rules::repository, errors::GatewayError, proxy::state::AppState};

use super::types::DeleteResponse;

pub async fn delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(rule_id): Path<String>,
) -> Result<Json<DeleteResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    Ok(Json(DeleteResponse {
        ok: repository::delete(pool, &rule_id).await?,
    }))
}
