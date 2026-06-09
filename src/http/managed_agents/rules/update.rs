use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{
    db::managed_agents::rules::{
        repository,
        schema::{RuleRow, UpdateRule},
    },
    errors::GatewayError,
    proxy::state::AppState,
};

pub async fn update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(rule_id): Path<String>,
    Json(input): Json<UpdateRule>,
) -> Result<Json<RuleRow>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    let rule = repository::update(pool, &rule_id, input)
        .await?
        .ok_or_else(|| GatewayError::NotFound("not found".to_owned()))?;
    Ok(Json(rule))
}
