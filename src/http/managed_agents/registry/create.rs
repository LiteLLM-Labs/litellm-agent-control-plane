use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};

use crate::{
    db::managed_agents::registry::{
        repository,
        schema::{CreateManagedAgent, ManagedAgentRow},
    },
    errors::GatewayError,
    proxy::state::AppState,
};

pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateManagedAgent>,
) -> Result<(StatusCode, Json<ManagedAgentRow>), GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    let row = repository::create(pool, input).await?;
    Ok((StatusCode::CREATED, Json(row)))
}
