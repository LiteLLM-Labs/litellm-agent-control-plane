use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};

use crate::{
    db::managed_agents::{
        memory::{repository, schema::MemoryRow},
        registry,
    },
    errors::GatewayError,
    proxy::state::AppState,
};

use super::types::StoreMemoryRequest;

pub async fn store(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Json(input): Json<StoreMemoryRequest>,
) -> Result<(StatusCode, Json<MemoryRow>), GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    if registry::repository::get(pool, &agent_id).await?.is_none() {
        return Err(GatewayError::NotFound("not found".to_owned()));
    }
    let row = repository::store(pool, &agent_id, input.key, input.value, input.always_on).await?;
    Ok((StatusCode::CREATED, Json(row)))
}
