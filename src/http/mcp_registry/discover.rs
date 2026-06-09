use std::{collections::HashMap, sync::Arc};

use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

use super::{substitute_vars, tools::fetch_tools};

/// Request body for `POST /v1/mcp/discover`.
#[derive(Debug, Deserialize)]
pub struct DiscoverRequest {
    /// The MCP server URL. May contain `${VAR_NAME}` placeholders.
    pub url: String,
    /// Static headers to send. Values may contain `${VAR_NAME}` placeholders.
    #[serde(default)]
    pub static_headers: HashMap<String, String>,
    /// Variable values used to substitute placeholders in `url` and `static_headers`.
    #[serde(default)]
    pub variables: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct DiscoverResponse {
    pub tools: Vec<Value>,
}

/// POST /v1/mcp/discover — discover tools from an arbitrary MCP server URL.
///
/// Runs server-side so CORS restrictions and private API keys are never
/// exposed to the browser.
pub async fn discover_tools(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<DiscoverRequest>,
) -> Result<Json<DiscoverResponse>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;

    let url = body.url.trim();
    if url.is_empty() {
        return Err(GatewayError::InvalidConfig(
            "discover: url is required".to_owned(),
        ));
    }

    let resolved_url = substitute_vars(url, &body.variables);
    let resolved_url = resolved_url.trim_end_matches('/');

    let mut req = state
        .http
        .post(resolved_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");

    for (name, val_template) in &body.static_headers {
        let resolved_val = substitute_vars(val_template, &body.variables);
        if let (Ok(n), Ok(hv)) = (
            axum::http::HeaderName::from_bytes(name.as_bytes()),
            axum::http::HeaderValue::from_str(&resolved_val),
        ) {
            req = req.header(n, hv);
        }
    }

    let tools = fetch_tools(req).await?;
    Ok(Json(DiscoverResponse { tools }))
}
