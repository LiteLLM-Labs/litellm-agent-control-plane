use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Serialize;

use crate::{
    db::managed_agents::routines::repository, errors::GatewayError, proxy::state::AppState,
};

#[derive(Debug, Serialize)]
pub struct DeleteRoutineResponse {
    pub ok: bool,
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(routine_id): Path<String>,
) -> Result<(StatusCode, Json<DeleteRoutineResponse>), GatewayError> {
    let pool = crate::http::managed_agents::db(&state, &headers)?;
    let ok = repository::delete(pool, &routine_id).await?;
    if !ok {
        return Err(GatewayError::NotFound("routine not found".to_owned()));
    }
    Ok((StatusCode::OK, Json(DeleteRoutineResponse { ok })))
}
