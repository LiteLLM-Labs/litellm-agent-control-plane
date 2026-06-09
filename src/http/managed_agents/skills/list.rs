use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};

use crate::{db::managed_agents::skills::repository, errors::GatewayError, proxy::state::AppState};

use super::types::{ListSkillsQuery, SkillsResponse};

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ListSkillsQuery>,
) -> Result<Json<SkillsResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    Ok(Json(SkillsResponse {
        skills: repository::list(pool, query.owner_id.as_deref()).await?,
    }))
}
