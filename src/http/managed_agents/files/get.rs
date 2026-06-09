use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{db::managed_agents::files::repository, errors::GatewayError, proxy::state::AppState};

pub async fn get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((agent_id, path)): Path<(String, String)>,
) -> Result<Response, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    let file = repository::get(pool, &agent_id, &path)
        .await?
        .ok_or_else(|| GatewayError::NotFound("file not found".to_owned()))?;

    let (content_type, body) = if file.encoding == "base64" {
        let bytes = STANDARD
            .decode(file.content)
            .map_err(|_| GatewayError::InvalidJsonMessage("invalid stored base64".to_owned()))?;
        ("application/octet-stream", Body::from(bytes))
    } else {
        ("text/plain; charset=utf-8", Body::from(file.content))
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .body(body)
        .map_err(|err| GatewayError::InvalidJsonMessage(err.to_string()))
}
