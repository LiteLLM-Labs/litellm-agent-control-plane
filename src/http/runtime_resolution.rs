use std::sync::Arc;

use sqlx::PgPool;

use crate::{
    db::managed_agents::harnesses,
    errors::GatewayError,
    http::{
        agent_runtimes::{load_credential, RuntimeCredential},
        runtime_harnesses::helpers::load_harness_api_key,
    },
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

pub(crate) async fn resolve_runtime(
    pool: &PgPool,
    state: &AppState,
    alias: &str,
) -> Result<ResolvedRuntime, GatewayError> {
    // 1. Try static registry first.
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

    let key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let (api_key, api_base, _, _) = load_harness_api_key(pool, alias, &key).await?;

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
