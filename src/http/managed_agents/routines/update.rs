use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{
    db::managed_agents::routines::{
        repository,
        schema::{RoutineRow, UpdateRoutine},
    },
    errors::GatewayError,
    proxy::state::AppState,
};

pub async fn update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(routine_id): Path<String>,
    Json(input): Json<UpdateRoutine>,
) -> Result<Json<RoutineRow>, GatewayError> {
    let pool = crate::http::managed_agents::db(&state, &headers)?;
    let routine = repository::update(pool, &routine_id, input)
        .await?
        .ok_or_else(|| GatewayError::NotFound("routine not found".to_owned()))?;
    Ok(Json(routine))
}
