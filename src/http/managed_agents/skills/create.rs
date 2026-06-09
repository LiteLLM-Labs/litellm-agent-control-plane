use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};

use crate::{
    db::managed_agents::skills::{
        repository,
        schema::{CreateSkill, SkillRow},
    },
    errors::GatewayError,
    proxy::state::AppState,
};

pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateSkill>,
) -> Result<(StatusCode, Json<SkillRow>), GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    Ok((
        StatusCode::CREATED,
        Json(repository::create(pool, input).await?),
    ))
}
