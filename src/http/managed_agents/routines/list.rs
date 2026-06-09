use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};

use crate::{
    db::managed_agents::routines::repository, errors::GatewayError, proxy::state::AppState,
};

use super::types::{ListRoutinesQuery, RoutinesResponse};

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ListRoutinesQuery>,
) -> Result<Json<RoutinesResponse>, GatewayError> {
    let pool = crate::http::managed_agents::db(&state, &headers)?;
    Ok(Json(RoutinesResponse {
        routines: repository::list(pool, query.agent_id.as_deref()).await?,
    }))
}
