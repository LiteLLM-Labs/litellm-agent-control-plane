use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{db::credentials, errors::GatewayError};

use super::credential::VaultCredential;

const STORE_ACTOR: &str = "runtime_provision";

#[derive(Debug, Default)]
pub(super) struct StoredVault {
    pub(super) vault_id: Option<String>,
    pub(super) credential_keys: BTreeSet<String>,
    pub(super) credential_fingerprints: BTreeMap<String, String>,
}

pub(super) async fn load_stored_vault(
    pool: &PgPool,
    store_name: &str,
) -> Result<StoredVault, GatewayError> {
    let Some(row) = credentials::get_by_name(pool, store_name).await? else {
        return Ok(StoredVault::default());
    };
    Ok(StoredVault {
        vault_id: row
            .credential_values
            .get("vault_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        credential_keys: stored_credential_keys(&row.credential_values),
        credential_fingerprints: stored_credential_fingerprints(&row.credential_values),
    })
}

pub(super) fn stored_credential_changed(
    stored: &StoredVault,
    required: &[VaultCredential],
) -> bool {
    let required_fingerprints = required
        .iter()
        .map(|credential| (credential.storage_key(), credential.fingerprint()))
        .collect::<BTreeMap<_, _>>();

    stored
        .credential_keys
        .iter()
        .any(|key| !required_fingerprints.contains_key(key))
        || required_fingerprints.iter().any(|(key, fingerprint)| {
            stored
                .credential_fingerprints
                .get(key)
                .is_some_and(|stored| stored != fingerprint)
        })
}

pub(super) fn stored_credential_keys(values: &Value) -> BTreeSet<String> {
    let mut keys: BTreeSet<String> = values
        .get("credential_keys")
        .and_then(Value::as_array)
        .map(|keys| {
            keys.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    keys.extend(
        values
            .get("credential_urls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|url| format!("mcp:{url}")),
    );
    keys
}

pub(super) fn stored_credential_fingerprints(values: &Value) -> BTreeMap<String, String> {
    values
        .get("credential_fingerprints")
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) async fn save_stored_vault(
    pool: &PgPool,
    store_name: &str,
    stored: &StoredVault,
) -> Result<(), GatewayError> {
    let credential_keys = stored
        .credential_keys
        .iter()
        .cloned()
        .collect::<Vec<String>>();
    let credential_urls = stored
        .credential_keys
        .iter()
        .filter_map(|key| key.strip_prefix("mcp:").map(str::to_owned))
        .collect::<Vec<String>>();
    let credential_fingerprints = stored.credential_fingerprints.clone();
    credentials::upsert(
        pool,
        store_name,
        json!({
            "vault_id": stored.vault_id,
            "credential_keys": credential_keys,
            "credential_fingerprints": credential_fingerprints,
            "credential_urls": credential_urls,
        }),
        json!({
            "provider": "anthropic",
            "purpose": "managed_agent_vault",
        }),
        STORE_ACTOR,
    )
    .await
}
