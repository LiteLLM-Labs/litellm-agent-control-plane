use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{
    db::managed_agents::registry::{
        repository,
        schema::{ManagedAgentRow, UpdateManagedAgent},
    },
    errors::GatewayError,
    proxy::state::AppState,
};

pub async fn update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Json(input): Json<UpdateManagedAgent>,
) -> Result<Json<ManagedAgentRow>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    let row = repository::update(pool, &agent_id, input)
        .await?
        .ok_or_else(|| GatewayError::NotFound("not found".to_owned()))?;
    Ok(Json(row))
}
