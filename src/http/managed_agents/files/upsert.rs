use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{
    db::managed_agents::{files::repository, registry},
    errors::GatewayError,
    proxy::state::AppState,
};

use super::types::{FileJsonBody, FileUpsertResponse};

pub async fn upsert(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((agent_id, path)): Path<(String, String)>,
    body: Bytes,
) -> Result<Json<FileUpsertResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    if registry::repository::get(pool, &agent_id).await?.is_none() {
        return Err(GatewayError::NotFound("agent not found".to_owned()));
    }

    let content_type = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let (content, encoding) = if content_type.contains("application/json") {
        let parsed: FileJsonBody = serde_json::from_slice(&body)?;
        if let Some(content_base64) = parsed.content_base64 {
            (content_base64, Some("base64".to_owned()))
        } else if let Some(content) = parsed.content {
            (
                content,
                parsed
                    .encoding
                    .or_else(|| Some(repository::encoding_for_path(&path).to_owned())),
            )
        } else {
            return Err(GatewayError::InvalidJsonMessage(
                "content required".to_owned(),
            ));
        }
    } else {
        let encoding = repository::encoding_for_path(&path).to_owned();
        let content = if encoding == "base64" {
            STANDARD.encode(&body)
        } else {
            String::from_utf8(body.to_vec()).map_err(|_| {
                GatewayError::InvalidJsonMessage("file body must be utf8".to_owned())
            })?
        };
        (content, Some(encoding))
    };

    let file = repository::upsert(pool, &agent_id, &path, content, encoding.as_deref()).await?;
    Ok(Json(FileUpsertResponse {
        ok: true,
        path: file.path,
        encoding: file.encoding,
        size_bytes: file.size_bytes,
    }))
}
