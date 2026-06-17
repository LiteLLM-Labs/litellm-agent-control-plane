use serde_json::Value;
use sqlx::PgPool;

use crate::{
    db::{credentials, managed_agents::registry::schema::ManagedAgentRow},
    errors::GatewayError,
    proxy::{credential_crypto, state::AppState},
};

const DEFAULT_UI_VAULT_USER: &str = "local";

pub(super) async fn resolve_agent_vault_keys(
    state: &AppState,
    pool: &PgPool,
    agent: &ManagedAgentRow,
    environment: &mut Value,
) -> Result<(), GatewayError> {
    let key_names: Vec<String> = agent
        .vault_keys
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    if key_names.is_empty() {
        return Ok(());
    }
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let owner_id = agent.owner_id.as_deref().unwrap_or("");
    let env_obj = environment.as_object_mut().ok_or_else(|| {
        GatewayError::InvalidJsonMessage("environment must be an object".to_owned())
    })?;
    for key_name in &key_names {
        if let Some(encrypted) = resolve_agent_vault_key(pool, key_name, owner_id).await? {
            if let Ok(plaintext) = credential_crypto::decrypt_value(&encrypted, &enc_key) {
                env_obj.insert(key_name.clone(), Value::String(plaintext));
            }
        }
    }
    Ok(())
}

async fn resolve_agent_vault_key(
    pool: &PgPool,
    key_name: &str,
    owner_id: &str,
) -> Result<Option<String>, GatewayError> {
    for owner in vault_owner_candidates(owner_id) {
        if let Some(encrypted) =
            credentials::resolve_personal_vault_key(pool, key_name, &owner).await?
        {
            return Ok(Some(encrypted));
        }
    }
    credentials::resolve_global_vault_key(pool, key_name).await
}

fn vault_owner_candidates(owner_id: &str) -> Vec<String> {
    let owner_id = owner_id.trim();
    let mut owners = Vec::new();
    if !owner_id.is_empty() {
        owners.push(owner_id.to_owned());
    }
    if owner_id != DEFAULT_UI_VAULT_USER {
        owners.push(DEFAULT_UI_VAULT_USER.to_owned());
    }
    owners
}

#[cfg(test)]
mod tests {
    use super::vault_owner_candidates;

    #[test]
    fn vault_owner_candidates_fall_back_to_local() {
        assert_eq!(
            vault_owner_candidates("user-1"),
            vec!["user-1".to_owned(), "local".to_owned()]
        );
    }

    #[test]
    fn vault_owner_candidates_do_not_duplicate_local() {
        assert_eq!(vault_owner_candidates("local"), vec!["local".to_owned()]);
    }
}
