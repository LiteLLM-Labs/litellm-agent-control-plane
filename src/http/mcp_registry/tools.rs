mod filter;

use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method},
    Json,
};
use reqwest::{Client, Request, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    db::{
        credentials,
        mcp_servers::{repository, schema::McpServerRow},
    },
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, credential_crypto, state::AppState},
};

use super::{build_vars_map, substitute_vars};
use filter::filter_allowed_tools;

const MCP_PROTOCOL_VERSION: &str = "2025-03-26";
const MCP_PROTOCOL_VERSION_HEADER: &str = "mcp-protocol-version";
const MCP_SESSION_ID_HEADER: &str = "mcp-session-id";

#[derive(Debug, Serialize)]
pub struct ToolsResponse {
    pub server_id: String,
    pub tools: Vec<Value>,
}

#[derive(Deserialize)]
pub struct TestToolsRequest {
    pub variables: HashMap<String, String>,
}

pub fn extract_tools_from_response(text: &str, content_type: &str) -> Vec<Value> {
    let tools_from_value = |v: &Value| {
        v.pointer("/result/tools")
            .or_else(|| v.get("tools"))
            .and_then(Value::as_array)
            .cloned()
    };
    if content_type.contains("event-stream") || text.starts_with("data:") {
        for line in text.lines() {
            let data = line.strip_prefix("data:").map(str::trim).unwrap_or("");
            if !data.is_empty() {
                if let Ok(v) = serde_json::from_str::<Value>(data) {
                    if let Some(t) = tools_from_value(&v) {
                        return t;
                    }
                }
            }
        }
        return vec![];
    }
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| tools_from_value(&v))
        .unwrap_or_default()
}

fn extract_protocol_version(text: &str, content_type: &str) -> Option<String> {
    let version_from_value = |value: &Value| {
        value
            .pointer("/result/protocolVersion")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    if content_type.contains("event-stream") || text.starts_with("data:") {
        return text.lines().find_map(|line| {
            let data = line.strip_prefix("data:").map(str::trim).unwrap_or("");
            serde_json::from_str::<Value>(data)
                .ok()
                .and_then(|value| version_from_value(&value))
        });
    }
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| version_from_value(&value))
}

fn apply_static_headers(
    mut req: reqwest::RequestBuilder,
    static_headers: &Value,
    vars: &HashMap<String, String>,
) -> reqwest::RequestBuilder {
    if let Some(obj) = static_headers.as_object() {
        for (name, val) in obj {
            if let Some(template) = val.as_str() {
                let resolved = substitute_vars(template, vars);
                if let (Ok(n), Ok(hv)) = (
                    axum::http::HeaderName::from_bytes(name.as_bytes()),
                    axum::http::HeaderValue::from_str(&resolved),
                ) {
                    req = req.header(n, hv);
                }
            }
        }
    }
    req
}

pub(super) async fn fetch_tools(
    http: &Client,
    req: reqwest::RequestBuilder,
) -> Result<Vec<Value>, GatewayError> {
    let template = req.build().map_err(GatewayError::Upstream)?;
    let initialize = execute_rpc(
        http,
        &template,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": "litellm-agent-control-plane",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
        None,
        None,
    )
    .await?;
    let session_id = initialize.headers().get(MCP_SESSION_ID_HEADER).cloned();
    let (initialize_body, initialize_content_type) = successful_response_body(initialize).await?;
    let protocol_version = extract_protocol_version(&initialize_body, &initialize_content_type)
        .and_then(|value| HeaderValue::from_str(&value).ok())
        .unwrap_or_else(|| HeaderValue::from_static(MCP_PROTOCOL_VERSION));

    let discovery = async {
        let initialized = execute_rpc(
            http,
            &template,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            }),
            session_id.as_ref(),
            Some(&protocol_version),
        )
        .await?;
        successful_response_body(initialized).await?;

        let tools = execute_rpc(
            http,
            &template,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            }),
            session_id.as_ref(),
            Some(&protocol_version),
        )
        .await?;
        let (text, content_type) = successful_response_body(tools).await?;
        Ok(extract_tools_from_response(&text, &content_type))
    }
    .await;

    if let Some(session_id) = session_id.as_ref() {
        terminate_session(http, &template, session_id, &protocol_version).await;
    }

    discovery
}

fn rpc_request(
    template: &Request,
    payload: &Value,
    session_id: Option<&HeaderValue>,
    protocol_version: Option<&HeaderValue>,
) -> Result<Request, GatewayError> {
    let mut request = template.try_clone().ok_or_else(|| {
        GatewayError::InvalidConfig("MCP discovery request body is not reusable".to_owned())
    })?;
    *request.method_mut() = Method::POST;
    *request.body_mut() = Some(reqwest::Body::from(serde_json::to_vec(payload)?));
    if let Some(protocol_version) = protocol_version {
        request.headers_mut().insert(
            HeaderName::from_static(MCP_PROTOCOL_VERSION_HEADER),
            protocol_version.clone(),
        );
    }
    if let Some(session_id) = session_id {
        request.headers_mut().insert(
            HeaderName::from_static(MCP_SESSION_ID_HEADER),
            session_id.clone(),
        );
    }
    Ok(request)
}

async fn execute_rpc(
    http: &Client,
    template: &Request,
    payload: &Value,
    session_id: Option<&HeaderValue>,
    protocol_version: Option<&HeaderValue>,
) -> Result<Response, GatewayError> {
    http.execute(rpc_request(
        template,
        payload,
        session_id,
        protocol_version,
    )?)
    .await
    .map_err(GatewayError::Upstream)
}

async fn successful_response_body(response: Response) -> Result<(String, String), GatewayError> {
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = response.text().await.map_err(GatewayError::Upstream)?;
    if !status.is_success() {
        return Err(GatewayError::UpstreamHttp(status.as_u16(), body));
    }
    Ok((body, content_type))
}

async fn terminate_session(
    http: &Client,
    template: &Request,
    session_id: &HeaderValue,
    protocol_version: &HeaderValue,
) {
    let Some(mut request) = template.try_clone() else {
        return;
    };
    *request.method_mut() = Method::DELETE;
    *request.body_mut() = None;
    request.headers_mut().insert(
        HeaderName::from_static(MCP_PROTOCOL_VERSION_HEADER),
        protocol_version.clone(),
    );
    request.headers_mut().insert(
        HeaderName::from_static(MCP_SESSION_ID_HEADER),
        session_id.clone(),
    );
    if let Ok(response) = http.execute(request).await {
        let _ = response.bytes().await;
    }
}

fn require_active_server_url<'a>(
    server: &'a McpServerRow,
    server_id: &str,
) -> Result<&'a str, GatewayError> {
    if server.approval_status.as_deref() != Some("active") {
        return Err(GatewayError::NotFound(format!(
            "MCP server not found: {server_id}"
        )));
    }
    server
        .url
        .as_deref()
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| GatewayError::InvalidConfig("MCP server has no URL configured".to_owned()))
}

/// GET /v1/mcp/server/{server_id}/tools
pub async fn list_tools(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Result<Json<ToolsResponse>, GatewayError> {
    require_any_gateway_key(&headers, &state).await?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let server = repository::get(pool, &server_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound(format!("MCP server not found: {server_id}")))?;
    let url = require_active_server_url(&server, &server_id)?;
    let user_id = super::caller_user_id(&headers, &state);
    let enc_key_opt =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref()).ok();
    let vars: HashMap<String, String> = if let Some(key) = enc_key_opt.as_deref() {
        build_vars_map(pool, &server, &user_id, key).await
    } else {
        HashMap::new()
    };
    // Keep the trailing slash: streamable-HTTP MCP servers live at `/mcp/` and
    // stripping it triggers a redirect that drops the Authorization header.
    let tools_url = substitute_vars(url, &vars);
    let req = state
        .http
        .post(&tools_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");
    let req = apply_static_headers(req, &server.static_headers, &vars);
    let req = apply_user_credential(
        &state,
        req,
        pool,
        &server,
        &server_id,
        &user_id,
        enc_key_opt.as_deref(),
    )
    .await?;
    let tools = filter_allowed_tools(fetch_tools(&state.http, req).await?, &server.allowed_tools);
    Ok(Json(ToolsResponse { server_id, tools }))
}

async fn apply_user_credential(
    state: &AppState,
    mut req: reqwest::RequestBuilder,
    pool: &sqlx::PgPool,
    server: &McpServerRow,
    server_id: &str,
    user_id: &str,
    enc_key: Option<&str>,
) -> Result<reqwest::RequestBuilder, GatewayError> {
    if server
        .static_headers
        .as_object()
        .is_some_and(|o| !o.is_empty())
    {
        return Ok(req);
    }
    let Some(key) = enc_key else { return Ok(req) };
    let cred_name = format!("mcp_user:{server_id}:{user_id}");
    let dec = |enc: &str| credential_crypto::decrypt_value(enc, key).ok();
    let cred: Option<String> =
        match super::oauth::resolve_oauth_bearer_token(state, pool, server, user_id, key).await? {
            Some(value) => Some(value),
            None => {
                let user_credential = if let Some(row) =
                    credentials::get_personal_by_name(pool, &cred_name, user_id).await?
                {
                    let encrypted = row
                        .credential_values
                        .get("value")
                        .and_then(|value| value.as_str())
                        .filter(|value| !value.trim().is_empty());
                    match encrypted {
                        Some(encrypted) => Some(credential_crypto::decrypt_value(encrypted, key)?),
                        None => None,
                    }
                } else {
                    None
                };
                user_credential.or_else(|| {
                    server
                        .credentials
                        .get("value")
                        .and_then(|v| v.as_str())
                        .and_then(dec)
                        .or_else(|| {
                            server
                                .credentials
                                .get("api_key")
                                .and_then(|v| v.as_str())
                                .map(str::to_owned)
                        })
                })
            }
        };
    if let Some(cred) = cred {
        req = match server.auth_type.as_deref().unwrap_or("bearer_token") {
            "api_key" => req.header("x-api-key", cred),
            "basic" => req.header("Authorization", format!("Basic {cred}")),
            _ => req.header("Authorization", format!("Bearer {cred}")),
        };
    }
    Ok(req)
}

/// POST /v1/mcp/server/{server_id}/tools — test with caller-supplied variable values.
pub async fn test_tools(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Json(body): Json<TestToolsRequest>,
) -> Result<Json<ToolsResponse>, GatewayError> {
    require_any_gateway_key(&headers, &state).await?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let server = repository::get(pool, &server_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound(format!("MCP server not found: {server_id}")))?;
    let url = server
        .url
        .as_deref()
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| {
            GatewayError::InvalidConfig("MCP server has no URL configured".to_owned())
        })?;
    let enc_key_opt =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref()).ok();
    let mut vars = build_instance_vars(&server, enc_key_opt.as_deref());
    vars.extend(body.variables);
    // Keep the trailing slash: streamable-HTTP MCP servers live at `/mcp/` and
    // stripping it triggers a redirect that drops the Authorization header.
    let tools_url = substitute_vars(url, &vars);
    let req = state
        .http
        .post(&tools_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");
    let req = apply_static_headers(req, &server.static_headers, &vars);
    let tools = filter_allowed_tools(fetch_tools(&state.http, req).await?, &server.allowed_tools);
    Ok(Json(ToolsResponse { server_id, tools }))
}

fn build_instance_vars(server: &McpServerRow, enc_key: Option<&str>) -> HashMap<String, String> {
    let mut m = HashMap::new();
    let Some(key) = enc_key else { return m };
    let Some(vars_def) = server.mcp_info.get("variables").and_then(|v| v.as_array()) else {
        return m;
    };
    for var in vars_def {
        let Some(name) = var.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        if var.get("scope").and_then(|v| v.as_str()) != Some("per_user") {
            if let Some(raw) = server.credentials.get(name).and_then(|v| v.as_str()) {
                let val =
                    credential_crypto::decrypt_value(raw, key).unwrap_or_else(|_| raw.to_owned());
                m.insert(name.to_owned(), val);
            }
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::{
        matchers::{body_json, header, method},
        Mock, MockServer, ResponseTemplate,
    };

    #[tokio::test]
    async fn discovers_tools_with_a_stateful_mcp_session() {
        let server = MockServer::start().await;
        let session_id = "discovery-session";
        let negotiated_version = "2024-11-05";

        Mock::given(method("POST"))
            .and(body_json(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "litellm-agent-control-plane",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            })))
            .and(header("x-test-auth", "secret"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header(MCP_SESSION_ID_HEADER, session_id)
                    .set_body_json(json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "result": {
                            "protocolVersion": negotiated_version,
                            "capabilities": {},
                            "serverInfo": {"name": "stateful-test", "version": "1"}
                        }
                    })),
            )
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(body_json(json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            })))
            .and(header(MCP_SESSION_ID_HEADER, session_id))
            .and(header(MCP_PROTOCOL_VERSION_HEADER, negotiated_version))
            .respond_with(ResponseTemplate::new(202))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(body_json(json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            })))
            .and(header(MCP_SESSION_ID_HEADER, session_id))
            .and(header(MCP_PROTOCOL_VERSION_HEADER, negotiated_version))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"browser_snapshot\"}]}}\n\n",
                "text/event-stream",
            ))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("DELETE"))
            .and(header(MCP_SESSION_ID_HEADER, session_id))
            .and(header(MCP_PROTOCOL_VERSION_HEADER, negotiated_version))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let http = Client::new();
        let request = http
            .post(server.uri())
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("x-test-auth", "secret");
        let tools = fetch_tools(&http, request).await.unwrap();

        assert_eq!(tools, vec![json!({"name": "browser_snapshot"})]);
        let requests = server.received_requests().await.unwrap();
        assert_eq!(
            requests
                .iter()
                .map(|request| request.method.as_str())
                .collect::<Vec<_>>(),
            vec!["POST", "POST", "POST", "DELETE"]
        );
        server.verify().await;
    }
}
