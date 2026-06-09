use crate::{
    db::{credentials, managed_agents::harnesses},
    errors::GatewayError,
    http::{
        agent_runtime_tools::runtime_tools, agent_runtimes::load_credential,
        runtime_resolution::harness_credential_name,
    },
    proxy::{credential_crypto, provider_credentials::mask_api_key, state::AppState},
    sdk::agents::AgentRuntime,
};

use super::HarnessResponse;

pub(crate) async fn build_harnesses_list(
    state: &AppState,
    pool: &sqlx::PgPool,
) -> Result<Vec<HarnessResponse>, GatewayError> {
    let mut result = Vec::new();

    // Built-in / default runtimes
    for entry in AgentRuntime::catalog() {
        let credential = match load_credential(state, entry.id).await {
            Ok(c) => Some(c),
            Err(GatewayError::InvalidJsonMessage(_)) | Err(GatewayError::MissingDatabase) => None,
            Err(e) => return Err(e),
        };
        result.push(HarnessResponse {
            alias: entry.id.to_owned(),
            api_spec: entry.id.to_owned(),
            display_name: entry.name.to_owned(),
            api_base: credential
                .as_ref()
                .map(|c| c.api_base.clone())
                .unwrap_or_else(|| entry.default_api_base.to_owned()),
            is_default: true,
            connected: credential.is_some(),
            masked_api_key: credential.map(|c| mask_api_key(&c.api_key)),
            tools: runtime_tools(entry.id).to_vec(),
        });
    }

    // Custom harnesses from DB
    let custom = harnesses::repository::list(pool).await?;
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref()).ok();

    for harness in custom {
        let (connected, masked_api_key, resolved_api_base) = if let Some(ref key) = enc_key {
            match load_harness_api_key(pool, &harness.alias, key).await {
                Ok((api_key, api_base)) => {
                    let masked = mask_api_key(&api_key);
                    (true, Some(masked), api_base)
                }
                Err(_) => (false, None, harness.api_base.clone()),
            }
        } else {
            (false, None, harness.api_base.clone())
        };

        result.push(HarnessResponse {
            alias: harness.alias.clone(),
            api_spec: harness.api_spec.clone(),
            display_name: harness.alias.clone(),
            api_base: resolved_api_base,
            is_default: false,
            connected,
            masked_api_key,
            tools: runtime_tools(&harness.api_spec).to_vec(),
        });
    }

    Ok(result)
}

async fn load_harness_api_key(
    pool: &sqlx::PgPool,
    alias: &str,
    enc_key: &str,
) -> Result<(String, String), GatewayError> {
    let cred_name = harness_credential_name(alias);
    let row = credentials::get_by_name(pool, &cred_name)
        .await?
        .ok_or_else(|| {
            GatewayError::InvalidJsonMessage(format!("no credential for harness: {alias}"))
        })?;
    let vals = row.credential_values.as_object().ok_or_else(|| {
        GatewayError::InvalidConfig("harness credential_values must be an object".to_owned())
    })?;
    let api_key = decrypt_field(vals, "api_key", enc_key)?;
    let api_base = decrypt_field(vals, "api_base", enc_key)?;
    Ok((api_key, api_base))
}

pub(super) fn decrypt_field(
    values: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    key: &str,
) -> Result<String, GatewayError> {
    let enc = values.get(field).and_then(|v| v.as_str()).ok_or_else(|| {
        GatewayError::InvalidConfig(format!("harness credential missing field: {field}"))
    })?;
    credential_crypto::decrypt_value(enc, key)
}
