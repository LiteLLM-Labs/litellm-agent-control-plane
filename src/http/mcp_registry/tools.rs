use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
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

pub(super) async fn fetch_tools(req: reqwest::RequestBuilder) -> Result<Vec<Value>, GatewayError> {
    let res = req
        .json(&serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}))
        .send()
        .await
        .map_err(GatewayError::Upstream)?;
    if res.status().is_success() {
        let ct = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let text = res.text().await.map_err(GatewayError::Upstream)?;
        Ok(extract_tools_from_response(&text, &ct))
    } else {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        Err(GatewayError::UpstreamHttp(status, body))
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
    require_any_gateway_key(&headers, &state)?;
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
    let tools_url = substitute_vars(url, &vars);
    let tools_url = tools_url.trim_end_matches('/');
    let req = state
        .http
        .post(tools_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");
    let req = apply_static_headers(req, &server.static_headers, &vars);
    let req = apply_user_credential(
        req,
        pool,
        &server,
        &server_id,
        &user_id,
        enc_key_opt.as_deref(),
    )
    .await;
    let tools = fetch_tools(req).await?;
    Ok(Json(ToolsResponse { server_id, tools }))
}

async fn apply_user_credential(
    mut req: reqwest::RequestBuilder,
    pool: &sqlx::PgPool,
    server: &McpServerRow,
    server_id: &str,
    user_id: &str,
    enc_key: Option<&str>,
) -> reqwest::RequestBuilder {
    if server
        .static_headers
        .as_object()
        .is_some_and(|o| !o.is_empty())
    {
        return req;
    }
    let Some(key) = enc_key else { return req };
    let cred_name = format!("mcp_user:{server_id}:{user_id}");
    let dec = |enc: &str| credential_crypto::decrypt_value(enc, key).ok();
    let cred: Option<String> = credentials::get_personal_by_name(pool, &cred_name, user_id)
        .await
        .ok()
        .flatten()
        .and_then(|r| {
            r.credential_values
                .get("value")
                .and_then(|v| v.as_str())
                .and_then(dec)
        })
        .or_else(|| {
            server
                .credentials
                .get("value")
                .and_then(|v| v.as_str())
                .and_then(dec)
        })
        .or_else(|| {
            server
                .credentials
                .get("api_key")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        });
    if let Some(cred) = cred {
        req = match server.auth_type.as_deref().unwrap_or("bearer_token") {
            "api_key" => req.header("x-api-key", cred),
            "basic" => req.header("Authorization", format!("Basic {cred}")),
            _ => req.header("Authorization", format!("Bearer {cred}")),
        };
    }
    req
}

/// POST /v1/mcp/server/{server_id}/tools — test with caller-supplied variable values.
pub async fn test_tools(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Json(body): Json<TestToolsRequest>,
) -> Result<Json<ToolsResponse>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
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
    let tools_url = substitute_vars(url, &vars);
    let tools_url = tools_url.trim_end_matches('/');
    let req = state
        .http
        .post(tools_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");
    let req = apply_static_headers(req, &server.static_headers, &vars);
    let tools = fetch_tools(req).await?;
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
