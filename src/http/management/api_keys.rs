use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

#[derive(Debug, Deserialize)]
pub struct CreateGatewayApiKeyRequest {
    label: Option<String>,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    Ok(Json(json!({ "keys": state.api_keys.list() })))
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateGatewayApiKeyRequest>,
) -> Result<impl IntoResponse, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    Ok((
        StatusCode::CREATED,
        Json(state.api_keys.create(request.label)),
    ))
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    if state.api_keys.delete(&id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Ok(StatusCode::NOT_FOUND)
    }
}
