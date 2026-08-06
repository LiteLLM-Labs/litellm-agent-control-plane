use crate::{
    db::{credentials, managed_agents::harnesses},
    errors::GatewayError,
    http::{
        agent_runtime_tools::runtime_tools, agent_runtimes::load_credential,
        managed_agents::import::import_runtime_providers,
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
    let mut result = default_harnesses(state).await?;
    result.extend(custom_harnesses(state, pool).await?);
    append_import_providers(&mut result);
    Ok(result)
}

async fn default_harnesses(state: &AppState) -> Result<Vec<HarnessResponse>, GatewayError> {
    let mut result = Vec::new();
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
            codex_profile_type: None,
            codex_controller_alias: None,
        });
    }
    Ok(result)
}

async fn custom_harnesses(
    state: &AppState,
    pool: &sqlx::PgPool,
) -> Result<Vec<HarnessResponse>, GatewayError> {
    let mut result = Vec::new();
    let custom = harnesses::repository::list(pool).await?;
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref()).ok();
    for harness in custom {
        let (
            connected,
            masked_api_key,
            resolved_api_base,
            codex_profile_type,
            codex_controller_alias,
        ) = if let Some(ref key) = enc_key {
            match load_harness_api_key(pool, &harness.alias, key).await {
                Ok((api_key, api_base, profile_type, controller_alias)) => {
                    let masked = mask_api_key(&api_key);
                    (true, Some(masked), api_base, profile_type, controller_alias)
                }
                Err(_) => (false, None, harness.api_base.clone(), None, None),
            }
        } else {
            (false, None, harness.api_base.clone(), None, None)
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
            codex_profile_type,
            codex_controller_alias,
        });
    }
    Ok(result)
}

fn append_import_providers(result: &mut Vec<HarnessResponse>) {
    for provider in import_runtime_providers() {
        if result
            .iter()
            .any(|harness| harness.alias == provider.id || harness.api_spec == provider.api_spec)
        {
            continue;
        }
        result.push(HarnessResponse {
            alias: provider.api_spec.to_owned(),
            api_spec: provider.api_spec.to_owned(),
            display_name: provider.name.to_owned(),
            api_base: String::new(),
            is_default: true,
            connected: false,
            masked_api_key: None,
            tools: runtime_tools(provider.api_spec).to_vec(),
            codex_profile_type: None,
            codex_controller_alias: None,
        });
    }
}

pub(crate) async fn load_harness_api_key(
    pool: &sqlx::PgPool,
    alias: &str,
    enc_key: &str,
) -> Result<(String, String, Option<String>, Option<String>), GatewayError> {
    let cred_name = harness_credential_name(alias);
    let row = credentials::get_by_name(pool, &cred_name)
        .await?
        .ok_or_else(|| {
            GatewayError::InvalidJsonMessage(format!("no credential for harness: {alias}"))
        })?;
    let vals = row.credential_values.as_object().ok_or_else(|| {
        GatewayError::InvalidConfig("harness credential_values must be an object".to_owned())
    })?;
    if let Some((profile_type, controller_alias)) = codex_profile_metadata(vals) {
        let controller_credential =
            credentials::get_by_name(pool, &harness_credential_name(controller_alias))
                .await?
                .ok_or_else(|| {
                    GatewayError::InvalidJsonMessage(format!(
                        "no credential for Codex controller: {controller_alias}"
                    ))
                })?;
        let controller_values = controller_credential
            .credential_values
            .as_object()
            .ok_or_else(|| {
                GatewayError::InvalidConfig(
                    "Codex controller credential_values must be an object".to_owned(),
                )
            })?;
        let api_key = decrypt_field(controller_values, "api_key", enc_key)?;
        let controller_base = decrypt_field(controller_values, "api_base", enc_key)?;
        return Ok((
            api_key,
            codex_profile_api_base(&controller_base, alias),
            Some(profile_type.to_owned()),
            Some(controller_alias.to_owned()),
        ));
    }

    Ok((
        decrypt_field(vals, "api_key", enc_key)?,
        decrypt_field(vals, "api_base", enc_key)?,
        None,
        None,
    ))
}

fn codex_profile_api_base(controller_base: &str, alias: &str) -> String {
    format!("{}/profiles/{alias}", controller_base.trim_end_matches('/'))
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

pub(super) fn codex_profile_metadata(
    values: &serde_json::Map<String, serde_json::Value>,
) -> Option<(&str, &str)> {
    Some((
        values.get("codex_profile_type")?.as_str()?,
        values.get("codex_controller_alias")?.as_str()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_providers_do_not_duplicate_builtin_runtime_specs() {
        let mut harnesses = vec![HarnessResponse {
            alias: "elastic_agent_builder".to_owned(),
            api_spec: "elastic_agent_builder".to_owned(),
            display_name: "Elastic Agent Builder".to_owned(),
            api_base: "http://localhost:5601".to_owned(),
            is_default: true,
            connected: false,
            masked_api_key: None,
            tools: Vec::new(),
            codex_profile_type: None,
            codex_controller_alias: None,
        }];

        append_import_providers(&mut harnesses);

        assert_eq!(harnesses.len(), 1);
        assert_eq!(harnesses[0].alias, "elastic_agent_builder");
    }

    #[test]
    fn reads_codex_profile_metadata_only_when_complete() {
        let complete = serde_json::json!({
            "codex_profile_type": "chatgpt",
            "codex_controller_alias": "Codex-app-server",
        });
        assert_eq!(
            codex_profile_metadata(complete.as_object().unwrap()),
            Some(("chatgpt", "Codex-app-server"))
        );
        assert_eq!(
            codex_profile_metadata(
                serde_json::json!({ "codex_profile_type": "chatgpt" })
                    .as_object()
                    .unwrap()
            ),
            None
        );
    }

    #[test]
    fn codex_profile_base_follows_controller_base() {
        assert_eq!(
            codex_profile_api_base("http://codex:8080/", "CodexChargpt"),
            "http://codex:8080/profiles/CodexChargpt"
        );
    }
}
