use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::credentials,
    errors::GatewayError,
    proxy::{
        auth::master_key::{require_any_gateway_key, require_master_key},
        credential_crypto,
        state::AppState,
    },
};

#[derive(Debug, Serialize)]
pub struct ListVaultKeysResponse {
    pub keys: Vec<VaultKeyEntry>,
}

#[derive(Debug, Serialize)]
pub struct VaultKeyEntry {
    pub key: String,
    pub scope: String,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SaveVaultKeyRequest {
    pub key: String,
    pub value: String,
    #[serde(default = "default_scope")]
    pub scope: String,
}

fn default_scope() -> String {
    "personal".to_owned()
}

#[derive(Debug, Serialize)]
pub struct SaveVaultKeyResponse {
    pub ok: bool,
}

#[derive(Debug, Serialize)]
pub struct DeleteVaultKeyResponse {
    pub ok: bool,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
) -> Result<Json<ListVaultKeysResponse>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let rows = credentials::list_vault_keys_for_user(pool, &user_id).await?;
    let keys = rows
        .into_iter()
        .map(|r| VaultKeyEntry {
            key: r.credential_name,
            scope: r.scope,
            updated_at: r.updated_at_ms,
        })
        .collect();
    Ok(Json(ListVaultKeysResponse { keys }))
}

pub async fn save(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
    Json(input): Json<SaveVaultKeyRequest>,
) -> Result<Json<SaveVaultKeyResponse>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;

    let scope = input.scope.as_str();
    if scope != "personal" && scope != "global" {
        return Err(GatewayError::InvalidJsonMessage(
            "scope must be 'personal' or 'global'".to_owned(),
        ));
    }
    if scope == "global" {
        require_master_key(
            &headers,
            state.config.general_settings.master_key.as_deref(),
        )?;
    }

    let key_name = input.key.trim();
    if key_name.is_empty() {
        return Err(GatewayError::InvalidJsonMessage(
            "key is required".to_owned(),
        ));
    }
    let value = input.value.trim();
    if value.is_empty() {
        return Err(GatewayError::InvalidJsonMessage(
            "value is required".to_owned(),
        ));
    }

    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let encrypted = credential_crypto::encrypt_value(value, &enc_key)?;

    let owner_id = if scope == "personal" {
        Some(user_id.as_str())
    } else {
        None
    };

    credentials::upsert_vault_key(pool, key_name, scope, owner_id, &encrypted, &user_id).await?;
    Ok(Json(SaveVaultKeyResponse { ok: true }))
}

pub async fn delete_personal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user_id, key_name)): Path<(String, String)>,
) -> Result<(StatusCode, Json<DeleteVaultKeyResponse>), GatewayError> {
    require_any_gateway_key(&headers, &state)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let deleted =
        credentials::delete_vault_key(pool, &key_name, "personal", Some(&user_id)).await?;
    let status = if deleted {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    };
    Ok((status, Json(DeleteVaultKeyResponse { ok: deleted })))
}

pub async fn list_global(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<ListVaultKeysResponse>, GatewayError> {
    require_admin(&state, &headers)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let rows = sqlx::query_as::<_, credentials::VaultKeyRow>(
        r#"
        SELECT
            credential_name,
            scope,
            owner_id,
            CAST(EXTRACT(EPOCH FROM updated_at) * 1000 AS BIGINT) AS updated_at_ms
        FROM "LiteLLM_CredentialsTable"
        WHERE scope = 'global' AND credential_name NOT LIKE 'provider:%'
        ORDER BY credential_name ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)?;

    let keys = rows
        .into_iter()
        .map(|r| VaultKeyEntry {
            key: r.credential_name,
            scope: r.scope,
            updated_at: r.updated_at_ms,
        })
        .collect();
    Ok(Json(ListVaultKeysResponse { keys }))
}

pub async fn save_global(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<SaveVaultKeyRequest>,
) -> Result<Json<SaveVaultKeyResponse>, GatewayError> {
    require_admin(&state, &headers)?;
    let key_name = input.key.trim();
    let value = input.value.trim();
    if key_name.is_empty() || value.is_empty() {
        return Err(GatewayError::InvalidJsonMessage(
            "key and value are required".to_owned(),
        ));
    }
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let encrypted = credential_crypto::encrypt_value(value, &enc_key)?;
    credentials::upsert_vault_key(pool, key_name, "global", None, &encrypted, "admin").await?;
    Ok(Json(SaveVaultKeyResponse { ok: true }))
}

pub async fn delete_global(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(key_name): Path<String>,
) -> Result<(StatusCode, Json<DeleteVaultKeyResponse>), GatewayError> {
    require_admin(&state, &headers)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let deleted = credentials::delete_vault_key(pool, &key_name, "global", None).await?;
    let status = if deleted {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    };
    Ok((status, Json(DeleteVaultKeyResponse { ok: deleted })))
}

fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), GatewayError> {
    require_master_key(headers, state.config.general_settings.master_key.as_deref())
}
