use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::managed_agents::spend_logs::{repository, schema::SpendLogRow},
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    q: Option<String>,
    status: Option<String>,
    model: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ListResponse {
    logs: Vec<SpendLogRow>,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<ListResponse>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let logs = repository::list(
        pool,
        query.q.as_deref(),
        query.status.as_deref(),
        query.model.as_deref(),
        query.limit.unwrap_or(100),
        query.offset.unwrap_or_default(),
    )
    .await?;
    Ok(Json(ListResponse { logs }))
}

pub async fn get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(request_id): Path<String>,
) -> Result<Json<SpendLogRow>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let log = repository::get(pool, &request_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound(format!("unknown spend log: {request_id}")))?;
    Ok(Json(log))
}
