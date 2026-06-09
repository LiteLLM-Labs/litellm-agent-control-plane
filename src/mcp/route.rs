use std::{collections::HashMap, sync::Arc};

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, Method},
    response::Response,
};

use crate::{
    errors::GatewayError,
    mcp::registry::McpServerRegistry,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

const SERVER_HEADER: &str = "x-litellm-mcp-server";

pub async fn streamable_http(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    let server_id = select_server_id(&state.mcp_servers, &headers, query.get("server"))?;
    let server = state.mcp_servers.resolve(server_id)?;
    crate::mcp::upstream::forward_streamable_http(&state.http, server, method, &headers, body).await
}

pub async fn streamable_http_server(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    let server = state.mcp_servers.resolve(&server_id)?;
    crate::mcp::upstream::forward_streamable_http(&state.http, server, method, &headers, body).await
}

fn select_server_id<'a>(
    registry: &'a McpServerRegistry,
    headers: &'a HeaderMap,
    query_server: Option<&'a String>,
) -> Result<&'a str, GatewayError> {
    if let Some(server_id) = query_server {
        return Ok(server_id.as_str());
    }

    if let Some(server_id) = headers
        .get(SERVER_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(server_id);
    }

    registry
        .only_server_id()
        .ok_or(GatewayError::MissingMcpServer)
}
