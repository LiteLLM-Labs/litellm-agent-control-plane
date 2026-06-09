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
        auth::master_key::require_master_key,
        credential_crypto,
        provider_credentials::{
            self, ProviderCredentialInput, ANTHROPIC_PROVIDER_ID, CURSOR_PROVIDER_ID,
            GEMINI_PROVIDER_ID, OPENCODE_PROVIDER_ID,
        },
        state::AppState,
    },
    sdk::agents::{AgentRuntime, CLAUDE_MANAGED_AGENTS, CURSOR, GEMINI_ANTIGRAVITY, OPENCODE},
};

use super::agent_runtime_tools::{runtime_tools, RuntimeTool};

/// Legacy ID used before we renamed the runtime.
const CLAUDE_AGENTS_RUNTIME_LEGACY: &str = "claude_agents";

/// Opaque credential loaded from the DB for a runtime.
#[derive(Debug, Clone)]
pub struct RuntimeCredential {
    pub(crate) api_key: String,
    pub(crate) api_base: String,
}

#[derive(Debug, Serialize)]
pub struct AgentRuntimesResponse {
    pub runtimes: Vec<RuntimeResponse>,
}

#[derive(Debug, Serialize)]
pub struct RuntimeResponse {
    pub id: String,
    pub name: String,
    pub default_api_base: String,
    pub credential_provider_id: String,
    pub credential_provider_name: String,
    pub tools: Vec<RuntimeTool>,
    pub connected: bool,
    pub api_base: Option<String>,
    pub masked_api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SaveRuntimeCredentialRequest {
    pub api_key: String,
    pub api_base: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DeleteRuntimeCredentialResponse {
    pub ok: bool,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<AgentRuntimesResponse>, GatewayError> {
    require_admin(&state, &headers)?;
    Ok(Json(AgentRuntimesResponse {
        runtimes: runtime_values(&state).await?,
    }))
}

pub async fn save(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(runtime): Path<String>,
    Json(input): Json<SaveRuntimeCredentialRequest>,
) -> Result<Json<AgentRuntimesResponse>, GatewayError> {
    require_admin(&state, &headers)?;
    let runtime = canonical_runtime(&runtime)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let api_key = input.api_key.trim();
    if api_key.is_empty() {
        return Err(GatewayError::InvalidJsonMessage(
            "api_key is required".to_owned(),
        ));
    }
    let api_base = input
        .api_base
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| runtime_default_api_base(runtime).unwrap_or_default());
    provider_credentials::save(
        pool,
        &state.config,
        credential_provider_id(runtime)?,
        ProviderCredentialInput {
            api_key: api_key.to_owned(),
            api_base: api_base.to_owned(),
        },
    )
    .await?;
    Ok(Json(AgentRuntimesResponse {
        runtimes: runtime_values(&state).await?,
    }))
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(runtime): Path<String>,
) -> Result<(StatusCode, Json<DeleteRuntimeCredentialResponse>), GatewayError> {
    require_admin(&state, &headers)?;
    let runtime = canonical_runtime(&runtime)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let provider_id = credential_provider_id(runtime)?;
    let deleted =
        credentials::delete_by_name(pool, &provider_credentials::credential_name(provider_id))
            .await?;
    let deleted_runtime =
        credentials::delete_by_name(pool, &legacy_credential_name(runtime)).await?;
    let deleted_legacy = if runtime == CLAUDE_MANAGED_AGENTS {
        credentials::delete_by_name(pool, &legacy_credential_name(CLAUDE_AGENTS_RUNTIME_LEGACY))
            .await?
    } else {
        false
    };
    Ok((
        StatusCode::OK,
        Json(DeleteRuntimeCredentialResponse {
            ok: deleted || deleted_runtime || deleted_legacy,
        }),
    ))
}

pub async fn load_credential(
    state: &AppState,
    runtime: &str,
) -> Result<RuntimeCredential, GatewayError> {
    let runtime = canonical_runtime(runtime)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    if let Some(credential) =
        provider_credentials::load(pool, &state.config, credential_provider_id(runtime)?).await?
    {
        return Ok(RuntimeCredential {
            api_key: credential.api_key,
            api_base: credential.api_base,
        });
    }
    let row = match credentials::get_by_name(pool, &legacy_credential_name(runtime)).await? {
        Some(row) => row,
        None if runtime == CLAUDE_MANAGED_AGENTS => {
            match credentials::get_by_name(
                pool,
                &legacy_credential_name(CLAUDE_AGENTS_RUNTIME_LEGACY),
            )
            .await?
            {
                Some(row) => row,
                None => {
                    let provider =
                        provider_credentials::catalog_entry(credential_provider_id(runtime)?)?;
                    return Err(GatewayError::InvalidJsonMessage(format!(
                        "{} provider credentials are not configured",
                        provider.name
                    )));
                }
            }
        }
        None => {
            let provider = provider_credentials::catalog_entry(credential_provider_id(runtime)?)?;
            return Err(GatewayError::InvalidJsonMessage(format!(
                "{} provider credentials are not configured",
                provider.name
            )));
        }
    };
    let key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let values = row.credential_values.as_object().ok_or_else(|| {
        GatewayError::InvalidConfig("runtime credential_values must be an object".to_owned())
    })?;
    let api_key = decrypt(values, "api_key", &key)?;
    let api_base = decrypt(values, "api_base", &key)?;
    Ok(RuntimeCredential { api_key, api_base })
}

fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), GatewayError> {
    require_master_key(headers, state.config.general_settings.master_key.as_deref())
}

async fn runtime_values(state: &AppState) -> Result<Vec<RuntimeResponse>, GatewayError> {
    let mut values = Vec::new();
    for entry in AgentRuntime::catalog() {
        let provider = provider_credentials::catalog_entry(credential_provider_id(entry.id)?)?;
        let credential = match load_credential(state, entry.id).await {
            Ok(value) => Some(value),
            Err(GatewayError::InvalidJsonMessage(_)) | Err(GatewayError::MissingDatabase) => None,
            Err(error) => return Err(error),
        };
        values.push(RuntimeResponse {
            id: entry.id.to_owned(),
            name: entry.name.to_owned(),
            default_api_base: entry.default_api_base.to_owned(),
            credential_provider_id: provider.id.to_owned(),
            credential_provider_name: provider.name.to_owned(),
            tools: runtime_tools(entry.id).to_vec(),
            connected: credential.is_some(),
            api_base: credential.as_ref().map(|c| c.api_base.clone()),
            masked_api_key: credential.map(|c| provider_credentials::mask_api_key(&c.api_key)),
        });
    }
    Ok(values)
}

fn legacy_credential_name(runtime: &str) -> String {
    format!("agent-runtime:{runtime}")
}

/// Map a runtime string ID (possibly legacy) to its canonical form.
fn canonical_runtime(runtime: &str) -> Result<&'static str, GatewayError> {
    // Handle the legacy "claude_agents" alias.
    if runtime == CLAUDE_AGENTS_RUNTIME_LEGACY {
        return Ok(CLAUDE_MANAGED_AGENTS);
    }
    AgentRuntime::catalog()
        .iter()
        .find(|entry| entry.id == runtime)
        .map(|entry| entry.id)
        .ok_or_else(|| GatewayError::InvalidJsonMessage(format!("unsupported runtime: {runtime}")))
}

fn runtime_default_api_base(runtime: &str) -> Option<&'static str> {
    AgentRuntime::catalog()
        .iter()
        .find(|entry| entry.id == runtime)
        .map(|entry| entry.default_api_base)
}

/// Map a runtime ID to the provider credential ID used in the credential store.
///
/// NOTE: This has provider-specific string literals by design; a follow-up will
/// make providers self-register their credential provider ID.
fn credential_provider_id(runtime: &str) -> Result<&'static str, GatewayError> {
    match runtime {
        CLAUDE_MANAGED_AGENTS | CLAUDE_AGENTS_RUNTIME_LEGACY => Ok(ANTHROPIC_PROVIDER_ID),
        CURSOR => Ok(CURSOR_PROVIDER_ID),
        GEMINI_ANTIGRAVITY => Ok(GEMINI_PROVIDER_ID),
        OPENCODE => Ok(OPENCODE_PROVIDER_ID),
        _ => Err(GatewayError::InvalidConfig(format!(
            "no credential provider for runtime: {runtime}"
        ))),
    }
}

fn decrypt(
    values: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    key: &str,
) -> Result<String, GatewayError> {
    let encrypted = values
        .get(field)
        .and_then(|value| value.as_str())
        .ok_or_else(|| GatewayError::InvalidConfig(format!("credential is missing {field}")))?;
    credential_crypto::decrypt_value(encrypted, key)
}
