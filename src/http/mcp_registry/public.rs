use std::sync::Arc;

use axum::{extract::State, Json};
use serde::Serialize;
use serde_json::Value;

use crate::{
    db::mcp_servers::{repository, schema::McpServerRow},
    errors::GatewayError,
    proxy::state::AppState,
};

// ── response types ─────────────────────────────────────────────────────────────

/// A sanitised view of an MCP server row safe for public API responses.
/// The `credentials` and `env_vars` fields from `McpServerRow` are deliberately
/// omitted here to ensure stored secrets are never sent over the wire.
#[derive(Debug, Serialize)]
pub struct PublicMcpServer {
    pub server_id: String,
    pub server_name: Option<String>,
    pub alias: Option<String>,
    pub description: Option<String>,
    pub instructions: Option<String>,
    pub url: Option<String>,
    pub spec_path: Option<String>,
    pub transport: String,
    pub auth_type: Option<String>,
    pub created_at: i64,
    pub created_by: Option<String>,
    pub updated_at: i64,
    pub updated_by: Option<String>,
    pub mcp_info: Value,
    pub mcp_access_groups: Value,
    pub allowed_tools: Value,
    pub tool_name_to_display_name: Value,
    pub tool_name_to_description: Value,
    pub status: Option<String>,
    pub last_health_check: Option<i64>,
    pub health_check_error: Option<String>,
    pub command: Option<String>,
    pub args: Value,
    pub authorization_url: Option<String>,
    pub token_url: Option<String>,
    pub registration_url: Option<String>,
    pub oauth2_flow: Option<String>,
    pub allow_all_keys: bool,
    pub available_on_public_internet: bool,
    pub delegate_auth_to_upstream: bool,
    pub oauth_passthrough: bool,
    pub is_byok: bool,
    pub byok_description: Value,
    pub byok_api_key_help_url: Option<String>,
    pub source_url: Option<String>,
    pub timeout: Option<f64>,
    pub approval_status: Option<String>,
    pub submitted_by: Option<String>,
    pub submitted_at: Option<i64>,
    pub reviewed_at: Option<i64>,
    pub review_notes: Option<String>,
}

impl From<McpServerRow> for PublicMcpServer {
    fn from(row: McpServerRow) -> Self {
        Self {
            server_id: row.server_id,
            server_name: row.server_name,
            alias: row.alias,
            description: row.description,
            instructions: row.instructions,
            url: row.url,
            spec_path: row.spec_path,
            transport: row.transport,
            auth_type: row.auth_type,
            created_at: row.created_at,
            created_by: row.created_by,
            updated_at: row.updated_at,
            updated_by: row.updated_by,
            mcp_info: row.mcp_info,
            mcp_access_groups: row.mcp_access_groups,
            allowed_tools: row.allowed_tools,
            tool_name_to_display_name: row.tool_name_to_display_name,
            tool_name_to_description: row.tool_name_to_description,
            // credentials, env_vars, env, static_headers, extra_headers intentionally dropped
            status: row.status,
            last_health_check: row.last_health_check,
            health_check_error: row.health_check_error,
            command: row.command,
            args: row.args,
            authorization_url: row.authorization_url,
            token_url: row.token_url,
            registration_url: row.registration_url,
            oauth2_flow: row.oauth2_flow,
            allow_all_keys: row.allow_all_keys,
            available_on_public_internet: row.available_on_public_internet,
            delegate_auth_to_upstream: row.delegate_auth_to_upstream,
            oauth_passthrough: row.oauth_passthrough,
            is_byok: row.is_byok,
            byok_description: row.byok_description,
            byok_api_key_help_url: row.byok_api_key_help_url,
            source_url: row.source_url,
            timeout: row.timeout,
            approval_status: row.approval_status,
            submitted_by: row.submitted_by,
            submitted_at: row.submitted_at,
            reviewed_at: row.reviewed_at,
            review_notes: row.review_notes,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct McpHubResponse {
    pub data: Vec<PublicMcpServer>,
}

// ── handlers ───────────────────────────────────────────────────────────────────

/// GET /public/mcp_hub — no auth required.
///
/// Returns all MCP servers where `available_on_public_internet = TRUE` and
/// `approval_status = 'active'`. If no database is configured, returns an empty
/// list rather than an error so the endpoint is always safe to call.
/// Credentials and env_vars are never included in the response.
pub async fn mcp_hub(
    State(state): State<Arc<AppState>>,
) -> Result<Json<McpHubResponse>, GatewayError> {
    let Some(pool) = state.db.as_ref() else {
        return Ok(Json(McpHubResponse { data: vec![] }));
    };

    let rows = repository::list_public(pool).await?;
    let data = rows.into_iter().map(PublicMcpServer::from).collect();
    Ok(Json(McpHubResponse { data }))
}
