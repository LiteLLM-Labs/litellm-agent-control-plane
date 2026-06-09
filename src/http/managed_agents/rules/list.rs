use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};

use crate::{db::managed_agents::rules::repository, errors::GatewayError, proxy::state::AppState};

use super::types::{ListRulesQuery, RulesResponse};

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ListRulesQuery>,
) -> Result<Json<RulesResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    Ok(Json(RulesResponse {
        rules: repository::list(pool, query.owner_id.as_deref()).await?,
    }))
}
