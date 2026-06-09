use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};

use crate::{
    db::managed_agents::skills::{repository, schema::SkillRow},
    errors::GatewayError,
    proxy::state::AppState,
};

pub async fn get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(skill_id): Path<String>,
) -> Result<Json<SkillRow>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    let skill = repository::get(pool, &skill_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("not found".to_owned()))?;
    Ok(Json(skill))
}
