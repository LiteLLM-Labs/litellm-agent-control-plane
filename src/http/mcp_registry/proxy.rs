use std::{collections::HashMap, sync::Arc};

use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{
        header::{ACCEPT, CONTENT_TYPE},
        HeaderMap, HeaderName, HeaderValue, Method, StatusCode,
    },
    response::Response,
};
use futures_util::TryStreamExt;

use crate::{
    db::{credentials, mcp_servers::repository},
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, credential_crypto, state::AppState},
};

use super::{caller_user_id, substitute_vars};

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

    // ── 1. Resolve server ─────────────────────────────────────────────────────
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let server = repository::get_by_name(pool, &server_name)
        .await?
        .ok_or_else(|| GatewayError::NotFound(format!("MCP server '{server_name}' not found")))?;

    // ── 2. Target URL ─────────────────────────────────────────────────────────
    let base_url = server
        .url
        .as_deref()
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| {
            GatewayError::InvalidJsonMessage("MCP server has no URL configured".to_owned())
        })?;

    // ── 3. Resolve variables ──────────────────────────────────────────────────
    let user_id = caller_user_id(&headers, &state);
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;

    let vars = resolve_variables(pool, &server, &user_id, &enc_key).await?;

    // Substitute ${VAR_NAME} in the URL (e.g. parameterized server IDs).
    let target_url = substitute_vars(base_url.trim_end_matches('/'), &vars);

    // ── 4. Build outbound request ─────────────────────────────────────────────
    let mut req = build_outbound_request(
        &state.http,
        method,
        &target_url,
        &headers,
        &server.static_headers,
        &vars,
    )?;

    // Backwards-compat: fall back to apply_auth if no static_headers and auth_type is set.
    let has_static_headers = server
        .static_headers
        .as_object()
        .is_some_and(|o| !o.is_empty());
    if !has_static_headers {
        let credential: Option<String> =
            resolve_user_credential(pool, &server.server_id, &user_id, &enc_key)
                .await?
                .or_else(|| resolve_server_credential(&server.credentials, &enc_key));
        if let Some(cred) = credential {
            req = apply_auth(req, server.auth_type.as_deref(), &cred);
        }
    }

    if !body.is_empty() {
        req = req.body(body);
    }

    // ── 5. Stream response back ───────────────────────────────────────────────
    let upstream = req.send().await.map_err(GatewayError::Upstream)?;
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let resp_headers = copy_response_headers(upstream.headers());
    let stream = upstream.bytes_stream().map_err(std::io::Error::other);
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    *response.headers_mut() = resp_headers;
    Ok(response)
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// Build a variable substitution map from the server's `mcp_info["variables"]` array.
///
/// Each variable has `{name, scope, description}`. Resolution:
/// - `scope = "instance"`: decrypt from `server.credentials[name]`; fall back to plaintext.
/// - `scope = "per_user"`: fetch from vault as `mcp_var:{server_id}:{var_name}` owned by user_id.
async fn resolve_variables(
    pool: &sqlx::PgPool,
    server: &crate::db::mcp_servers::schema::McpServerRow,
    user_id: &str,
    enc_key: &str,
) -> Result<HashMap<String, String>, GatewayError> {
    let mut map = HashMap::new();

    let vars = match server.mcp_info.get("variables").and_then(|v| v.as_array()) {
        Some(arr) => arr.clone(),
        None => return Ok(map),
    };

    for var in &vars {
        let name = match var.get("name").and_then(|v| v.as_str()) {
            Some(n) => n,
            None => continue,
        };
        let scope = var
            .get("scope")
            .and_then(|v| v.as_str())
            .unwrap_or("instance");

        let value: Option<String> = if scope == "per_user" {
            // Fetch from personal vault: key = mcp_var:{server_id}:{var_name}
            let vault_key = format!("mcp_var:{}:{}", server.server_id, name);
            credentials::get_personal_by_name(pool, &vault_key, user_id)
                .await
                .ok()
                .flatten()
                .and_then(|row| {
                    row.credential_values
                        .get("value")
                        .and_then(|v| v.as_str())
                        .and_then(|enc| credential_crypto::decrypt_value(enc, enc_key).ok())
                })
        } else {
            // scope = "instance": resolve from server.credentials[name]
            server
                .credentials
                .get(name)
                .and_then(|v| v.as_str())
                .map(|raw| {
                    // Try decryption first; fall back to plaintext if it fails.
                    credential_crypto::decrypt_value(raw, enc_key)
                        .unwrap_or_else(|_| raw.to_owned())
                })
        };

        if let Some(v) = value {
            map.insert(name.to_owned(), v);
        }
    }

    Ok(map)
}

/// Build a reqwest request builder with forwarded inbound and static headers applied.
fn build_outbound_request(
    client: &reqwest::Client,
    method: Method,
    target_url: &str,
    inbound: &HeaderMap,
    static_headers: &serde_json::Value,
    vars: &HashMap<String, String>,
) -> Result<reqwest::RequestBuilder, GatewayError> {
    let reqwest_method = reqwest::Method::from_bytes(method.as_str().as_bytes())
        .map_err(|_| GatewayError::InvalidJsonMessage("invalid HTTP method".to_owned()))?;

    let mut req = client.request(reqwest_method, target_url);

    for (name, value) in forward_headers(inbound) {
        req = req.header(name, value);
    }

    if let Some(obj) = static_headers.as_object() {
        for (name, val) in obj {
            if let Some(template) = val.as_str() {
                let resolved = substitute_vars(template, vars);
                if let (Ok(n), Ok(hv)) = (
                    HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_str(&resolved),
                ) {
                    req = req.header(n, hv);
                }
            }
        }
    }

    Ok(req)
}

/// Look up the personal vault key for this (server, user) pair and decrypt it.
/// Key format: `mcp_user:{server_id}:{user_id}`
async fn resolve_user_credential(
    pool: &sqlx::PgPool,
    server_id: &str,
    user_id: &str,
    enc_key: &str,
) -> Result<Option<String>, GatewayError> {
    let key_name = format!("mcp_user:{}:{}", server_id, user_id);
    let Some(row) = credentials::get_personal_by_name(pool, &key_name, user_id).await? else {
        return Ok(None);
    };
    // credential_values is stored as { "value": "<encrypted>" }
    let Some(encrypted) = row
        .credential_values
        .as_object()
        .and_then(|m| m.get("value"))
        .and_then(|v| v.as_str())
    else {
        return Ok(None);
    };
    let plaintext = credential_crypto::decrypt_value(encrypted, enc_key)?;
    Ok(Some(plaintext))
}

/// Fall back to the server's own `credentials` JSONB field.
/// Supports `{ "value": "<encrypted>" }` or `{ "api_key": "<plaintext>" }`.
fn resolve_server_credential(credentials: &serde_json::Value, enc_key: &str) -> Option<String> {
    let obj = credentials.as_object()?;

    if let Some(encrypted) = obj.get("value").and_then(|v| v.as_str()) {
        // Best-effort decrypt; if decryption fails we skip this credential.
        return credential_crypto::decrypt_value(encrypted, enc_key).ok();
    }

    if let Some(api_key) = obj.get("api_key").and_then(|v| v.as_str()) {
        if !api_key.trim().is_empty() {
            return Some(api_key.to_owned());
        }
    }

    None
}

/// Apply the appropriate `Authorization` / `x-api-key` header based on auth_type.
fn apply_auth(
    req: reqwest::RequestBuilder,
    auth_type: Option<&str>,
    credential: &str,
) -> reqwest::RequestBuilder {
    match auth_type {
        Some("bearer_token") => req.header("Authorization", format!("Bearer {credential}")),
        Some("api_key") => req.header("x-api-key", credential),
        Some("basic") => req.header("Authorization", format!("Basic {credential}")),
        _ => req,
    }
}

/// Forward a safe subset of inbound request headers to the upstream.
fn forward_headers(headers: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    const CONNECT_PROTOCOL_VERSION: &str = "connect-protocol-version";

    let mut out = Vec::new();
    for name in [ACCEPT, CONTENT_TYPE] {
        if let Some(value) = headers.get(&name) {
            out.push((name, value.clone()));
        }
    }
    // Forward Connect-Protocol-Version (used by connect-rpc / MCP over HTTP).
    if let Some(value) = headers.get(CONNECT_PROTOCOL_VERSION) {
        if let Ok(name) = HeaderName::from_bytes(CONNECT_PROTOCOL_VERSION.as_bytes()) {
            out.push((name, value.clone()));
        }
    }
    out
}

/// Copy response headers that should be relayed to the caller.
fn copy_response_headers(headers: &reqwest::header::HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    let relay = [
        CONTENT_TYPE.as_str(),
        "cache-control",
        "connect-protocol-version",
        "connect-content-encoding",
    ];
    for name_str in relay {
        if let Some(value) = headers.get(name_str) {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(name_str.as_bytes()),
                HeaderValue::from_bytes(value.as_bytes()),
            ) {
                out.insert(name, val);
            }
        }
    }
    out
}
