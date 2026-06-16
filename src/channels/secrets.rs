use sqlx::PgPool;

use crate::{
    db::credentials,
    errors::GatewayError,
    proxy::{credential_crypto, state::AppState, vault},
};

const DEFAULT_VAULT_USER: &str = "default";
const LEGACY_UI_VAULT_USER: &str = "local";

pub(crate) async fn load_secret(state: &AppState, key: &str) -> Result<String, GatewayError> {
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    if let Some(value) = vault::load(pool, &state.config, DEFAULT_VAULT_USER, key).await? {
        return Ok(value);
    }
    if let Some(value) = vault::load(pool, &state.config, LEGACY_UI_VAULT_USER, key).await? {
        return Ok(value);
    }
    let legacy_key = format!("vault:{DEFAULT_VAULT_USER}:{key}");
    if let Some(value) = load_legacy_secret(state, pool, &legacy_key, DEFAULT_VAULT_USER).await? {
        return Ok(value);
    }
    let legacy_ui_key = format!("vault:{LEGACY_UI_VAULT_USER}:{key}");
    if let Some(value) =
        load_legacy_secret(state, pool, &legacy_ui_key, LEGACY_UI_VAULT_USER).await?
    {
        return Ok(value);
    }
    Err(GatewayError::InvalidConfig(format!(
        "vault key is not configured: {key}"
    )))
}

async fn load_legacy_secret(
    state: &AppState,
    pool: &PgPool,
    key: &str,
    owner_id: &str,
) -> Result<Option<String>, GatewayError> {
    let Some(encrypted) = credentials::resolve_vault_key(pool, key, owner_id).await? else {
        return Ok(None);
    };
    let encryption_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    credential_crypto::decrypt_value(&encrypted, &encryption_key).map(Some)
}
