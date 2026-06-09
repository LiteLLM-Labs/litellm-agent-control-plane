use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};

use crate::{
    db::managed_agents::rules::{
        repository,
        schema::{CreateRule, RuleRow},
    },
    errors::GatewayError,
    proxy::state::AppState,
};

pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateRule>,
) -> Result<(StatusCode, Json<RuleRow>), GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    Ok((
        StatusCode::CREATED,
        Json(repository::create(pool, input).await?),
    ))
}
