use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{db::managed_agents::inbox::repository, errors::GatewayError, proxy::state::AppState};

use super::types::{OkResponse, ResolveRequest};

pub async fn resolve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    Json(input): Json<ResolveRequest>,
) -> Result<Json<OkResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    if !repository::resolve_issue(pool, &item_id, input.note).await? {
        return Err(GatewayError::NotFound(
            "item not found or already resolved".to_owned(),
        ));
    }
    Ok(Json(OkResponse { ok: true }))
}
