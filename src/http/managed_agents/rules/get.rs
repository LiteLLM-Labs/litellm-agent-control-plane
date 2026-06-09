use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{db::managed_agents::rules::repository, errors::GatewayError, proxy::state::AppState};

pub async fn get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(rule_id): Path<String>,
) -> Result<Json<crate::db::managed_agents::rules::schema::RuleRow>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    let rule = repository::get(pool, &rule_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("not found".to_owned()))?;
    Ok(Json(rule))
}
