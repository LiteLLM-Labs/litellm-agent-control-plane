use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};

use crate::{
    db::managed_agents::routines::{
        repository,
        schema::{CreateRoutine, RoutineRow},
    },
    errors::GatewayError,
    proxy::state::AppState,
};

pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateRoutine>,
) -> Result<(StatusCode, Json<RoutineRow>), GatewayError> {
    let pool = crate::http::managed_agents::db(&state, &headers)?;
    Ok((
        StatusCode::CREATED,
        Json(repository::create(pool, input).await?),
    ))
}
