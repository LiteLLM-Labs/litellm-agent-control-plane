use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::mcp_servers::{
        repository,
        schema::{CreateMcpServer, McpServerRow, UpdateMcpServer},
    },
    errors::GatewayError,
    proxy::{auth::master_key::require_master_key, state::AppState},
};

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct ListResponse {
    pub data: Vec<McpServerRow>,
}

#[derive(Debug, Serialize)]
pub struct DeleteResponse {
    pub ok: bool,
}

// ---------------------------------------------------------------------------
// Body type for PUT (server_id comes from the body, not the path)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct UpdateMcpServerBody {
    pub server_id: String,
    #[serde(flatten)]
    pub update: UpdateMcpServer,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), GatewayError> {
    require_master_key(headers, state.config.general_settings.master_key.as_deref())
}

fn pool(state: &AppState) -> Result<&sqlx::PgPool, GatewayError> {
    state.db.as_ref().ok_or(GatewayError::MissingDatabase)
}

/// A stable actor string for audit columns (`created_by` / `updated_by`).
/// We use the literal "admin" because admin endpoints are gated behind the
/// master key and there is no per-user identity at this layer.
const ACTOR: &str = "admin";

// ---------------------------------------------------------------------------
// GET /v1/mcp/server  — list all servers
// ---------------------------------------------------------------------------

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<ListResponse>, GatewayError> {
    require_admin(&state, &headers)?;
    let servers = repository::list(pool(&state)?).await?;
    Ok(Json(ListResponse { data: servers }))
}

// ---------------------------------------------------------------------------
// POST /v1/mcp/server  — create a server
// ---------------------------------------------------------------------------

pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateMcpServer>,
) -> Result<(StatusCode, Json<McpServerRow>), GatewayError> {
    require_admin(&state, &headers)?;
    let row = repository::create(pool(&state)?, input, ACTOR).await?;
    Ok((StatusCode::CREATED, Json(row)))
}

// ---------------------------------------------------------------------------
// PUT /v1/mcp/server  — update a server (server_id in body)
// ---------------------------------------------------------------------------

pub async fn update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<UpdateMcpServerBody>,
) -> Result<Json<McpServerRow>, GatewayError> {
    require_admin(&state, &headers)?;
    let row = repository::update(pool(&state)?, &body.server_id, body.update, ACTOR)
        .await?
        .ok_or_else(|| {
            GatewayError::NotFound(format!("MCP server '{}' not found", body.server_id))
        })?;
    Ok(Json(row))
}

// ---------------------------------------------------------------------------
// GET /v1/mcp/server/{id}  — get a single server
// ---------------------------------------------------------------------------

pub async fn get_one(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Result<Json<McpServerRow>, GatewayError> {
    require_admin(&state, &headers)?;
    let row = repository::get(pool(&state)?, &server_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound(format!("MCP server '{server_id}' not found")))?;
    Ok(Json(row))
}

// ---------------------------------------------------------------------------
// DELETE /v1/mcp/server/{id}  — delete a server
// ---------------------------------------------------------------------------

pub async fn delete_one(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Result<Json<DeleteResponse>, GatewayError> {
    require_admin(&state, &headers)?;
    if !repository::delete(pool(&state)?, &server_id).await? {
        return Err(GatewayError::NotFound(format!(
            "MCP server '{server_id}' not found"
        )));
    }
    Ok(Json(DeleteResponse { ok: true }))
}
