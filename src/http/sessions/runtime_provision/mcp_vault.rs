use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    errors::GatewayError,
    proxy::state::AppState,
    sdk::agents::{AgentRuntime, ANTHROPIC_VERSION, MANAGED_AGENTS_BETA},
};

use super::CreatedRuntimeSession;

mod credential;
mod store;

use credential::{environment_credentials, gateway_mcp_credentials, stable_hash, VaultCredential};
use store::{load_stored_vault, save_stored_vault, stored_credential_changed, StoredVault};

const STORE_PREFIX: &str = "anthropic-managed-agent-vault:";

pub(super) async fn vault_ids(
    state: &AppState,
    pool: &PgPool,
    created: &CreatedRuntimeSession,
    mcp_servers: &[Value],
) -> Result<Option<Vec<String>>, GatewayError> {
    if created.resolved.agent_runtime != AgentRuntime::ClaudeManagedAgents {
        return Ok(None);
    }

    let mut required: Vec<VaultCredential> = gateway_mcp_credentials(state, mcp_servers)
        .into_iter()
        .map(VaultCredential::McpStaticBearer)
        .collect();
    required.extend(
        environment_credentials(created)?
            .into_iter()
            .map(VaultCredential::EnvironmentVariable),
    );
    if required.is_empty() {
        return Ok(None);
    }

    let store_name = store_name(created);
    let mut stored = load_stored_vault(pool, &store_name).await?;
    let mut changed = false;
    if stored_credential_changed(&stored, &required) {
        stored = StoredVault::default();
        changed = true;
    }
    let vault_id = match stored.vault_id.clone() {
        Some(vault_id) => vault_id,
        None => {
            let vault_id = create_vault(state, created).await?;
            stored.vault_id = Some(vault_id.clone());
            changed = true;
            vault_id
        }
    };

    for credential in required {
        let credential_key = credential.storage_key();
        let credential_fingerprint = credential.fingerprint();
        let unchanged = stored
            .credential_fingerprints
            .get(&credential_key)
            .map(|stored| stored == &credential_fingerprint)
            .unwrap_or(true);
        if stored.credential_keys.contains(&credential_key) && unchanged {
            continue;
        }
        create_credential(state, created, &vault_id, &credential).await?;
        stored.credential_keys.insert(credential_key.clone());
        stored
            .credential_fingerprints
            .insert(credential_key, credential_fingerprint);
        changed = true;
    }

    if changed {
        save_stored_vault(pool, &store_name, &stored).await?;
    }

    Ok(Some(vec![vault_id]))
}

async fn create_vault(
    state: &AppState,
    created: &CreatedRuntimeSession,
) -> Result<String, GatewayError> {
    let response = state
        .http
        .post(format!(
            "{}/vaults?beta=true",
            anthropic_v1_base(&created.resolved.credential.api_base)
        ))
        .header("x-api-key", &created.resolved.credential.api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", MANAGED_AGENTS_BETA)
        .json(&json!({ "display_name": "LiteLLM MCP Gateway" }))
        .send()
        .await
        .map_err(GatewayError::Upstream)?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GatewayError::SandboxError(format!(
            "Anthropic vault create failed with status {status}: {body}"
        )));
    }
    let vault: Value = response.json().await.map_err(GatewayError::Upstream)?;
    vault
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| GatewayError::SandboxError("Anthropic vault response missing id".to_owned()))
}

async fn create_credential(
    state: &AppState,
    created: &CreatedRuntimeSession,
    vault_id: &str,
    credential: &VaultCredential,
) -> Result<(), GatewayError> {
    let response = state
        .http
        .post(format!(
            "{}/vaults/{vault_id}/credentials?beta=true",
            anthropic_v1_base(&created.resolved.credential.api_base)
        ))
        .header("x-api-key", &created.resolved.credential.api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", MANAGED_AGENTS_BETA)
        .json(&json!({ "auth": credential.auth() }))
        .send()
        .await
        .map_err(GatewayError::Upstream)?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GatewayError::SandboxError(format!(
            "Anthropic vault credential create failed with status {status}: {body}"
        )));
    }
    Ok(())
}

fn store_name(created: &CreatedRuntimeSession) -> String {
    format!(
        "{STORE_PREFIX}{}",
        stable_hash(&format!(
            "{}\0{}\0{}",
            anthropic_v1_base(&created.resolved.credential.api_base),
            created.resolved.credential.api_key,
            created.agent.id
        ))
    )
}

fn anthropic_v1_base(api_base: &str) -> String {
    let base = api_base.trim_end_matches('/');
    if base.ends_with("/v1") {
        base.to_owned()
    } else {
        format!("{base}/v1")
    }
}

#[cfg(test)]
mod tests;
