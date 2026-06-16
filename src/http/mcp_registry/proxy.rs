mod credentials;
mod headers;
mod policy;

use std::{collections::HashSet, sync::Arc};

use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode},
    response::Response,
};
use futures_util::TryStreamExt;

use crate::{
    db::mcp_servers::repository,
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, credential_crypto, state::AppState},
};

use super::substitute_vars;

/// `GET|POST|PUT|DELETE|PATCH /{mcp_server_name}/mcp`
///
/// Proxies MCP protocol traffic to the registered upstream server, injecting
/// the calling user's credential (personal vault key, falling back to the
/// server's own stored credential).
pub async fn dynamic_mcp(
    State(state): State<Arc<AppState>>,
    Path(server_name): Path<String>,
    headers: HeaderMap,
    method: Method,
    body: Bytes,
) -> Result<Response, GatewayError> {
    require_any_gateway_key(&headers, &state)?;

    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let server = repository::get_by_name(pool, &server_name)
        .await?
        .ok_or_else(|| GatewayError::NotFound(format!("MCP server '{server_name}' not found")))?;
    let allowed_tools = policy::allowed_tools(&server.allowed_tools);
    let mcp_request = policy::parse_mcp_request(&body);
    if let Some(response) = policy::reject_disallowed_call(&mcp_request, &allowed_tools) {
        return Ok(response);
    }

    let base_url = server
        .url
        .as_deref()
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| {
            GatewayError::InvalidJsonMessage("MCP server has no URL configured".to_owned())
        })?;
    let user_id = super::caller_user_id(&headers, &state);
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let vars = credentials::resolve_variables(pool, &server, &user_id, &enc_key).await?;
    // Substitute ${VAR_NAME} in the URL (e.g. parameterized server IDs). Keep
    // the trailing slash intact: streamable-HTTP MCP servers live at `/mcp/`,
    // and stripping it makes the server redirect, dropping the Authorization
    // header on the way (a bogus "Malformed API Key" upstream failure).
    let target_url = substitute_vars(base_url, &vars);

    let mut req = headers::build_outbound_request(
        &state.http,
        method,
        &target_url,
        &headers,
        &server.static_headers,
        &vars,
    )?;
    if !headers::has_static_headers(&server.static_headers) {
        if let Some(cred) =
            credentials::resolve_auth_credential(&state, pool, &server, &user_id, &enc_key).await?
        {
            req = headers::apply_auth(req, server.auth_type.as_deref(), &cred);
        }
    }
    if !body.is_empty() {
        req = req.body(body);
    }

    let upstream = req.send().await.map_err(GatewayError::Upstream)?;
    response_from_upstream(upstream, &mcp_request, &allowed_tools).await
}

async fn response_from_upstream(
    upstream: reqwest::Response,
    mcp_request: &policy::McpRequest,
    allowed_tools: &HashSet<String>,
) -> Result<Response, GatewayError> {
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if policy::should_filter_tools_list(mcp_request, status, allowed_tools) {
        let headers = headers::copy_response_headers(upstream.headers());
        let content_type = upstream
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let text = upstream.text().await.map_err(GatewayError::Upstream)?;
        let filtered = policy::filter_tools_list_payload(&text, &content_type, allowed_tools);
        let mut response = Response::new(Body::from(filtered));
        *response.status_mut() = status;
        *response.headers_mut() = headers;
        return Ok(response);
    }

    let resp_headers = headers::copy_response_headers(upstream.headers());
    let stream = upstream.bytes_stream().map_err(std::io::Error::other);
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    *response.headers_mut() = resp_headers;
    Ok(response)
}
