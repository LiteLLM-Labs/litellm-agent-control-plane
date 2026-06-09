use axum::{
    body::{Body, Bytes},
    http::{
        header::{ACCEPT, CONTENT_TYPE},
        HeaderMap, HeaderName, HeaderValue, Method,
    },
    response::Response,
};
use futures_util::TryStreamExt;
use reqwest::Client;

use crate::{errors::GatewayError, mcp::registry::McpServer};

const MCP_SESSION_ID: &str = "mcp-session-id";
const MCP_PROTOCOL_VERSION: &str = "mcp-protocol-version";

pub async fn forward_streamable_http(
    http: &Client,
    server: &McpServer,
    method: Method,
    inbound_headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, GatewayError> {
    let mut request = http.request(method, server.url.clone());

    // 1. Protocol passthrough + admin-allowlisted inbound headers.
    for (name, value) in request_headers(inbound_headers, &server.extra_headers) {
        request = request.header(name, value);
    }
    // 2. Configured upstream auth (precomputed from auth_type).
    if let Some((name, value)) = &server.auth_header {
        request = request.header(name, value);
    }
    // 3. static_headers always win on conflict (applied last).
    for (name, value) in &server.static_headers {
        request = request.header(name, value);
    }
    if !body.is_empty() {
        request = request.body(body);
    }

    let upstream = request.send().await.map_err(GatewayError::Upstream)?;
    let status = upstream.status();
    let headers = response_headers(upstream.headers());
    let body_stream = upstream.bytes_stream().map_err(std::io::Error::other);
    let mut response = Response::new(Body::from_stream(body_stream));
    *response.status_mut() = status;
    *response.headers_mut() = headers;

    if !response.headers().contains_key(CONTENT_TYPE) {
        response
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }

    Ok(response)
}

/// Inbound headers to forward upstream: the fixed MCP protocol set, plus any
/// names the server config allowlisted via `extra_headers`. Credential headers
/// carrying the gateway master key are never forwarded, even if allowlisted, to
/// avoid leaking our key to a third-party MCP server.
fn request_headers(
    headers: &HeaderMap,
    extra_headers: &[String],
) -> Vec<(HeaderName, HeaderValue)> {
    let mut forwarded: Vec<(HeaderName, HeaderValue)> = [ACCEPT, CONTENT_TYPE]
        .into_iter()
        .chain(mcp_header_names())
        .filter_map(|name| headers.get(&name).map(|value| (name, value.clone())))
        .collect();

    for raw_name in extra_headers {
        if is_credential_header(raw_name) {
            continue;
        }
        let Ok(name) = HeaderName::from_bytes(raw_name.as_bytes()) else {
            continue;
        };
        // Skip names already covered by the protocol passthrough above.
        if forwarded.iter().any(|(existing, _)| *existing == name) {
            continue;
        }
        if let Some(value) = headers.get(&name) {
            forwarded.push((name, value.clone()));
        }
    }

    forwarded
}

/// Headers that carry the gateway's own credential and must never be forwarded
/// upstream. `name` is compared case-insensitively.
fn is_credential_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "authorization" || lower == "x-api-key" || lower.starts_with("x-litellm-")
}

fn response_headers(headers: &reqwest::header::HeaderMap) -> HeaderMap {
    let mut copied = HeaderMap::new();
    for name in [CONTENT_TYPE].into_iter().chain(mcp_header_names()) {
        if let Some(value) = headers
            .get(name.as_str())
            .and_then(|value| HeaderValue::from_bytes(value.as_bytes()).ok())
        {
            copied.insert(name, value);
        }
    }
    copied
}

fn mcp_header_names() -> [HeaderName; 2] {
    [
        HeaderName::from_static(MCP_SESSION_ID),
        HeaderName::from_static(MCP_PROTOCOL_VERSION),
    ]
}
