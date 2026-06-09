use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
};

use crate::{db::managed_agents::runs::repository, errors::GatewayError, proxy::state::AppState};

pub async fn logs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((agent_id, run_id)): Path<(String, String)>,
) -> Result<Response, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    let run = repository::get(pool, &agent_id, &run_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("run not found".to_owned()))?;

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(run.logs))
        .map_err(|err| GatewayError::InvalidJsonMessage(err.to_string()))
}
