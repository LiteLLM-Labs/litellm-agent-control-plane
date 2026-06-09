use serde::Serialize;
use sqlx::PgPool;

use crate::{
    db::credentials,
    errors::GatewayError,
    proxy::{config::GatewayConfig, credential_crypto},
};

#[derive(Debug, Clone, Serialize)]
pub struct VaultKeyEntry {
    pub key: String,
    pub source: String,
}

pub async fn save(
    pool: &PgPool,
    config: &GatewayConfig,
    user_id: &str,
    key: &str,
    value: &str,
) -> Result<(), GatewayError> {
    validate_key(key)?;
    let encryption_key =
        credential_crypto::encryption_key(config.general_settings.master_key.as_deref())?;
    let encrypted = credential_crypto::encrypt_value(value, &encryption_key)?;
    credentials::upsert_vault_key(pool, key, "personal", Some(user_id), &encrypted, user_id).await
}

pub async fn load(
    pool: &PgPool,
    config: &GatewayConfig,
    user_id: &str,
    key: &str,
) -> Result<Option<String>, GatewayError> {
    validate_key(key)?;
    let Some(encrypted) = credentials::resolve_vault_key(pool, key, user_id).await? else {
        return Ok(None);
    };
    let encryption_key =
        credential_crypto::encryption_key(config.general_settings.master_key.as_deref())?;
    credential_crypto::decrypt_value(&encrypted, &encryption_key).map(Some)
}

pub async fn list(pool: &PgPool, user_id: &str) -> Result<Vec<VaultKeyEntry>, GatewayError> {
    credentials::list_vault_keys_for_user(pool, user_id)
        .await?
        .into_iter()
        .map(|row| {
            Ok(VaultKeyEntry {
                key: row.credential_name,
                source: "vault".to_owned(),
            })
        })
        .collect()
}

pub async fn delete(pool: &PgPool, user_id: &str, key: &str) -> Result<bool, GatewayError> {
    validate_key(key)?;
    credentials::delete_vault_key(pool, key, "personal", Some(user_id)).await
}

fn validate_key(key: &str) -> Result<(), GatewayError> {
    if key.trim().is_empty() || key.contains('/') || key.contains(':') {
        return Err(GatewayError::InvalidJsonMessage(
            "vault key must be non-empty and cannot contain / or :".to_owned(),
        ));
    }
    Ok(())
}
