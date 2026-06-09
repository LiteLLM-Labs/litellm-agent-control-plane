use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

mod approval;
mod catalog;
mod definitions;
mod factory;
mod factory_slack;
pub(crate) mod factory_slack_app;
mod factory_slack_manifest;
mod selection;
mod session_management;
mod skill;
mod slack;
mod tools;

pub const PLATFORM_SESSION_MCP_ID: &str = "read_platform_session";
pub const SEND_PLATFORM_SESSION_MESSAGE_MCP_ID: &str = "send_platform_session_message";
pub const AGENT_MEMORY_MCP_ID: &str = "agent_memory";
pub const SEND_SLACK_MESSAGE_MCP_ID: &str = "send_slack_message";
pub const EDIT_AGENT_SKILL_MCP_ID: &str = "edit_agent_skill";
pub const PLATFORM_MCP_SERVER_NAME: &str = "platform";
pub const CREATE_MANAGED_AGENT_MCP_ID: &str = "create_managed_agent";
pub const CONNECT_AGENT_TO_SLACK_MCP_ID: &str = "connect_agent_to_slack";
pub const LIST_SLACK_AGENT_BINDINGS_MCP_ID: &str = "list_slack_agent_bindings";
pub const LIST_SUB_AGENTS_MCP_ID: &str = "list_sub_agents";
pub const RUN_SUB_AGENT_MCP_ID: &str = "run_sub_agent";
pub const REQUEST_HUMAN_APPROVAL_MCP_ID: &str = "request_human_approval";
pub const CHECK_HUMAN_APPROVAL_MCP_ID: &str = "check_human_approval";

pub use catalog::{platform_mcps, PlatformMcp};
pub use selection::selected_platform_mcp_ids;
pub(crate) use selection::sub_agent_ids;

pub fn platform_mcp_servers(
    state: &AppState,
    agent_id: &str,
    config: &Value,
    session_id: Option<&str>,
) -> Result<Vec<Value>, GatewayError> {
    let ids = selected_platform_mcp_ids(config);
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![json!({
        "name": PLATFORM_MCP_SERVER_NAME,
        "type": "url",
        "url": platform_mcp_url(state, agent_id, session_id)?
    })])
}

pub fn platform_mcp_toolsets(config: &Value) -> Vec<Value> {
    let ids = selected_platform_mcp_ids(config);
    if ids.is_empty() {
        return Vec::new();
    }
    vec![json!({
        "type": "mcp_toolset",
        "mcp_server_name": PLATFORM_MCP_SERVER_NAME,
        "default_config": {
            "enabled": false,
            "permission_policy": { "type": "always_allow" }
        },
        "configs": ids.into_iter().map(|id| json!({ "name": id, "enabled": true })).collect::<Vec<_>>()
    })]
}

pub fn platform_mcp_url(
    state: &AppState,
    agent_id: &str,
    session_id: Option<&str>,
) -> Result<String, GatewayError> {
    let base_url = proxy_base_url(state)?;
    let url = format!(
        "{}/mcp/platform/{}",
        base_url.trim_end_matches('/'),
        agent_id
    );
    Ok(match session_id {
        Some(session_id) if !session_id.trim().is_empty() => {
            format!("{url}?session_id={}", session_id.trim())
        }
        _ => url,
    })
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    Ok(Json(json!({ "platform_mcps": platform_mcps() })))
}

pub async fn serve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Query(query): Query<PlatformMcpQuery>,
    Json(request): Json<JsonRpcRequest>,
) -> Result<Json<Value>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let response = match request.method.as_str() {
        "initialize" => initialize_response(request.id),
        "tools/list" => json!({
            "jsonrpc": "2.0",
            "id": request.id,
            "result": { "tools": definitions::tool_defs() }
        }),
        "tools/call" => {
            let Some(params) = request.params else {
                return Ok(Json(rpc_error(request.id, -32602, "params are required")));
            };
            let result = call_tool(
                state.clone(),
                pool,
                &agent_id,
                query.session_id.as_deref(),
                params,
            )
            .await?;
            json!({ "jsonrpc": "2.0", "id": request.id, "result": result })
        }
        "notifications/initialized" => json!({
            "jsonrpc": "2.0",
            "id": request.id,
            "result": {}
        }),
        _ => rpc_error(request.id, -32601, "method not found"),
    };
    Ok(Json(response))
}

async fn call_tool(
    state: Arc<AppState>,
    pool: &PgPool,
    agent_id: &str,
    session_id: Option<&str>,
    params: Value,
) -> Result<Value, GatewayError> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| GatewayError::InvalidJsonMessage("tool name is required".to_owned()))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let payload = match name {
        PLATFORM_SESSION_MCP_ID => {
            session_management::read_platform_session(pool, arguments).await?
        }
        SEND_PLATFORM_SESSION_MESSAGE_MCP_ID => {
            session_management::send_platform_session_message(
                state.clone(),
                pool.clone(),
                arguments,
            )
            .await?
        }
        AGENT_MEMORY_MCP_ID => tools::agent_memory(pool, agent_id, arguments).await?,
        EDIT_AGENT_SKILL_MCP_ID => skill::edit_agent_skill(pool, agent_id, arguments).await?,
        SEND_SLACK_MESSAGE_MCP_ID => {
            slack::send_message(state.as_ref(), pool, agent_id, arguments).await?
        }
        CREATE_MANAGED_AGENT_MCP_ID => {
            factory::create_managed_agent(state.as_ref(), pool, arguments).await?
        }
        CONNECT_AGENT_TO_SLACK_MCP_ID => {
            factory_slack::connect_agent_to_slack(state.as_ref(), pool, agent_id, arguments).await?
        }
        LIST_SLACK_AGENT_BINDINGS_MCP_ID => {
            factory_slack::list_slack_bindings(pool, agent_id).await?
        }
        LIST_SUB_AGENTS_MCP_ID => tools::list_sub_agents(pool, agent_id).await?,
        RUN_SUB_AGENT_MCP_ID => {
            tools::run_sub_agent(state.clone(), pool.clone(), agent_id, arguments).await?
        }
        REQUEST_HUMAN_APPROVAL_MCP_ID => {
            approval::request_human_approval(pool, agent_id, session_id, arguments).await?
        }
        CHECK_HUMAN_APPROVAL_MCP_ID => approval::check_human_approval(pool, arguments).await?,
        _ => {
            return Ok(json!({
                "isError": true,
                "content": [{ "type": "text", "text": format!("unknown tool: {name}") }]
            }))
        }
    };
    Ok(json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&payload)? }]
    }))
}

pub(crate) fn required_str<'a>(value: &'a Value, field: &str) -> Result<&'a str, GatewayError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| GatewayError::InvalidJsonMessage(format!("{field} is required")))
}

pub(super) fn public_base_url(state: &AppState) -> Result<String, GatewayError> {
    proxy_base_url(state)
}

fn proxy_base_url(state: &AppState) -> Result<String, GatewayError> {
    state.resolved_mcp_proxy_base_url().ok_or_else(|| {
        GatewayError::InvalidConfig(
            "mcp_servers.proxy_base_url is required for platform MCPs".to_owned(),
        )
    })
}

fn rpc_error(id: Option<Value>, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

fn initialize_response(id: Option<Value>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "litellm-platform", "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct PlatformMcpQuery {
    pub session_id: Option<String>,
}
