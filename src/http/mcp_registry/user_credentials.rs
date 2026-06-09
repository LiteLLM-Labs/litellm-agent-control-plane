use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::{credentials, mcp_servers::repository},
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, credential_crypto, state::AppState},
};

use super::caller_user_id;

fn key_name(server_id: &str, user_id: &str) -> String {
    format!("mcp_user:{}:{}", server_id, user_id)
}

// ── request / response types ──────────────────────────────────────────────────

/// Body for POST /v1/mcp/server/{server_id}/user-credential
///
/// Accepts either `{ "credential": "..." }` or `{ "api_key": "..." }`.
#[derive(Debug, Deserialize)]
pub struct SaveUserCredentialRequest {
    pub credential: Option<String>,
    pub api_key: Option<String>,
}

impl SaveUserCredentialRequest {
    fn value(&self) -> Option<&str> {
        self.credential.as_deref().or(self.api_key.as_deref())
    }
}

#[derive(Debug, Serialize)]
pub struct SaveUserCredentialResponse {
    pub ok: bool,
}

#[derive(Debug, Serialize)]
pub struct DeleteUserCredentialResponse {
    pub ok: bool,
}

#[derive(Debug, Serialize)]
pub struct UserCredentialEntry {
    pub server_id: String,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ListUserCredentialsResponse {
    pub data: Vec<UserCredentialEntry>,
}

// ── handlers ──────────────────────────────────────────────────────────────────

/// POST /v1/mcp/server/{server_id}/user-credential
///
/// Store (or replace) the caller's personal credential for a BYOK MCP server.
pub async fn store(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Json(input): Json<SaveUserCredentialRequest>,
) -> Result<Json<SaveUserCredentialResponse>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;

    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;

    // Validate the server exists in the DB registry.
    let server_exists = repository::get(pool, &server_id).await?.is_some();
    if !server_exists {
        return Err(GatewayError::UnknownMcpServer(server_id));
    }

    let raw_value = input
        .value()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            GatewayError::InvalidJsonMessage("credential or api_key is required".to_owned())
        })?;

    let user_id = caller_user_id(&headers, &state);
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let encrypted = credential_crypto::encrypt_value(raw_value.trim(), &enc_key)?;

    let k = key_name(&server_id, &user_id);
    credentials::upsert_vault_key(pool, &k, "personal", Some(&user_id), &encrypted, &user_id)
        .await?;

    Ok(Json(SaveUserCredentialResponse { ok: true }))
}

/// DELETE /v1/mcp/server/{server_id}/user-credential
///
/// Remove the caller's personal credential for a BYOK MCP server.
/// Deletes both the legacy `mcp_user:{server_id}:{user_id}` key and any
/// per-variable `mcp_var:{server_id}:*` keys stored for this user.
/// Returns 200 if at least one credential was deleted, 404 if none found.
pub async fn delete_credential(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Result<(StatusCode, Json<DeleteUserCredentialResponse>), GatewayError> {
    require_any_gateway_key(&headers, &state)?;

    let user_id = caller_user_id(&headers, &state);

    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;

    // Delete the legacy single-credential key.
    let k = key_name(&server_id, &user_id);
    let deleted_legacy =
        credentials::delete_vault_key(pool, &k, "personal", Some(&user_id)).await?;

    // Also delete all per-variable keys (`mcp_var:{server_id}:*`) for this user.
    let mcp_var_prefix = format!("mcp_var:{}:", server_id);
    let deleted_vars = sqlx::query(
        r#"
        DELETE FROM "LiteLLM_CredentialsTable"
        WHERE credential_name LIKE $1
          AND scope = 'personal'
          AND owner_id = $2
        "#,
    )
    .bind(format!("{}%", mcp_var_prefix))
    .bind(&user_id)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?
    .rows_affected()
        > 0;

    let deleted = deleted_legacy || deleted_vars;
    let status = if deleted {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    };
    Ok((status, Json(DeleteUserCredentialResponse { ok: deleted })))
}

/// GET /v1/mcp/user-credentials
///
/// List all MCP server credentials that belong to the calling user.
/// Returns metadata only — never the encrypted value.
pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<ListUserCredentialsResponse>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;

    let user_id = caller_user_id(&headers, &state);

    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;

    // Fetch both legacy `mcp_user:{server_id}:{user_id}` keys and per-variable
    // `mcp_var:{server_id}:{var_name}` keys.  Both share scope='personal' and
    // owner_id = calling user.  We deduplicate by server_id, keeping the most
    // recently updated timestamp.
    let rows = sqlx::query_as::<_, credentials::VaultKeyRow>(
        r#"
        SELECT
            credential_name,
            scope,
            owner_id,
            CAST(EXTRACT(EPOCH FROM updated_at) * 1000 AS BIGINT) AS updated_at_ms
        FROM "LiteLLM_CredentialsTable"
        WHERE owner_id = $1
          AND (
                credential_name LIKE 'mcp_user:%'
             OR credential_name LIKE 'mcp_var:%'
          )
          AND scope = 'personal'
        ORDER BY credential_name ASC
        "#,
    )
    .bind(&user_id)
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)?;

    // Deduplicate: for per-variable keys (mcp_var:{server_id}:{var_name}) multiple
    // rows share the same server_id.  Keep the most-recent updated_at per server.
    use std::collections::HashMap;
    let mut by_server: HashMap<String, Option<i64>> = HashMap::new();
    for r in &rows {
        // Both key formats store server_id as the second colon-separated segment.
        let parts: Vec<&str> = r.credential_name.splitn(3, ':').collect();
        let server_id = parts.get(1).copied().unwrap_or("").to_owned();
        let entry = by_server.entry(server_id).or_insert(None);
        // Keep the maximum (most recent) timestamp across all rows for this server.
        match (entry, r.updated_at_ms) {
            (slot, Some(ts)) if slot.is_none_or(|prev| ts > prev) => {
                *slot = Some(ts);
            }
            _ => {}
        }
    }

    let data = by_server
        .into_iter()
        .map(|(server_id, updated_at)| UserCredentialEntry {
            server_id,
            updated_at,
        })
        .collect::<Vec<_>>();

    Ok(Json(ListUserCredentialsResponse { data }))
}
