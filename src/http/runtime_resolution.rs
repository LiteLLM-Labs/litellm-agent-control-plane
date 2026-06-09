use std::sync::Arc;

use sqlx::PgPool;

use crate::{
    db::{credentials, managed_agents::harnesses},
    errors::GatewayError,
    http::agent_runtimes::{load_credential, RuntimeCredential},
    proxy::{credential_crypto, state::AppState},
    sdk::{
        agents::AgentRuntime,
        providers::{self, base::runtime::RuntimeAdapter},
    },
};

pub(crate) struct ResolvedRuntime {
    pub alias: String,
    pub agent_runtime: AgentRuntime,
    pub credential: RuntimeCredential,
    pub adapter: Arc<dyn RuntimeAdapter>,
}

/// Legacy alias used before the runtime was renamed.
const CLAUDE_AGENTS_LEGACY: &str = "claude_agents";

pub(crate) async fn resolve_runtime(
    pool: &PgPool,
    state: &AppState,
    alias: &str,
) -> Result<ResolvedRuntime, GatewayError> {
    // Canonicalize legacy "claude_agents" so sessions stored with the old alias still resolve.
    let alias = if alias == CLAUDE_AGENTS_LEGACY {
        crate::sdk::agents::CLAUDE_MANAGED_AGENTS
    } else {
        alias
    };

    // 1. Try static registry first (claude_managed_agents, cursor, opencode)
    {
        let registry = providers::runtime_registry();
        if let Some(entry) = registry.entry_for_id(alias) {
            let credential = load_credential(state, alias).await?;
            return Ok(ResolvedRuntime {
                alias: alias.to_owned(),
                agent_runtime: entry.runtime,
                credential,
                adapter: entry.adapter.clone(),
            });
        }
    }

    // 2. Custom harness: DB lookup
    let harness = harnesses::repository::get_by_alias(pool, alias)
        .await?
        .ok_or_else(|| GatewayError::InvalidJsonMessage(format!("unsupported runtime: {alias}")))?;

    let registry = providers::runtime_registry();
    let entry = registry.entry_for_id(&harness.api_spec).ok_or_else(|| {
        GatewayError::InvalidConfig(format!("unknown api_spec: {}", harness.api_spec))
    })?;

    // Load credential from credentials table
    let cred_name = harness_credential_name(alias);
    let row = credentials::get_by_name(pool, &cred_name)
        .await?
        .ok_or_else(|| {
            GatewayError::InvalidJsonMessage(format!("no credential for harness: {alias}"))
        })?;

    let key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let values = row.credential_values.as_object().ok_or_else(|| {
        GatewayError::InvalidConfig("harness credential_values must be an object".to_owned())
    })?;
    let api_key = decrypt_field(values, "api_key", &key)?;
    let api_base = decrypt_field(values, "api_base", &key)?;

    Ok(ResolvedRuntime {
        alias: alias.to_owned(),
        agent_runtime: entry.runtime,
        credential: RuntimeCredential { api_key, api_base },
        adapter: entry.adapter.clone(),
    })
}

pub(crate) fn harness_credential_name(alias: &str) -> String {
    format!("runtime-harness:{alias}")
}

fn decrypt_field(
    values: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    key: &str,
) -> Result<String, GatewayError> {
    let enc = values.get(field).and_then(|v| v.as_str()).ok_or_else(|| {
        GatewayError::InvalidConfig(format!("harness credential missing field: {field}"))
    })?;
    credential_crypto::decrypt_value(enc, key)
}
