use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use crate::{errors::GatewayError, proxy::state::AppState};

use super::CreatedRuntimeSession;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct McpVaultCredential {
    pub(super) url: String,
    pub(super) token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct EnvironmentVaultCredential {
    pub(super) name: String,
    pub(super) value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum VaultCredential {
    McpStaticBearer(McpVaultCredential),
    EnvironmentVariable(EnvironmentVaultCredential),
}

impl VaultCredential {
    pub(super) fn storage_key(&self) -> String {
        match self {
            Self::McpStaticBearer(credential) => format!("mcp:{}", credential.url),
            Self::EnvironmentVariable(credential) => format!("env:{}", credential.name),
        }
    }

    pub(super) fn fingerprint(&self) -> String {
        match self {
            Self::McpStaticBearer(credential) => {
                stable_hash(&format!("mcp\0{}\0{}", credential.url, credential.token))
            }
            Self::EnvironmentVariable(credential) => {
                stable_hash(&format!("env\0{}\0{}", credential.name, credential.value))
            }
        }
    }

    pub(super) fn auth(&self) -> Value {
        match self {
            Self::McpStaticBearer(credential) => json!({
                "type": "static_bearer",
                "mcp_server_url": credential.url,
                "token": credential.token
            }),
            Self::EnvironmentVariable(credential) => json!({
                "type": "environment_variable",
                "secret_name": credential.name,
                "secret_value": credential.value
            }),
        }
    }
}

pub(super) fn gateway_mcp_credentials(
    state: &AppState,
    mcp_servers: &[Value],
) -> Vec<McpVaultCredential> {
    let Some(proxy_base) = state.resolved_mcp_proxy_base_url() else {
        return Vec::new();
    };
    let proxy_prefix = format!("{}/", proxy_base.trim_end_matches('/'));
    let master_key = state.config.general_settings.master_key.as_deref();
    let mut by_url = BTreeMap::new();

    for server in mcp_servers {
        let Some(url) = server
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|url| url.starts_with(&proxy_prefix))
        else {
            continue;
        };
        let token = server
            .get("authorization_token")
            .and_then(Value::as_str)
            .or(master_key);
        if let Some(token) = token {
            by_url
                .entry(url.to_owned())
                .or_insert_with(|| token.to_owned());
        }
    }

    by_url
        .into_iter()
        .map(|(url, token)| McpVaultCredential { url, token })
        .collect()
}

pub(super) fn environment_credentials(
    created: &CreatedRuntimeSession,
) -> Result<Vec<EnvironmentVaultCredential>, GatewayError> {
    let Some(environment) = created.environment.as_object() else {
        return Ok(Vec::new());
    };
    let mut credentials = Vec::new();
    for key_name in agent_vault_key_names(created) {
        let Some(value) = environment.get(&key_name).and_then(Value::as_str) else {
            continue;
        };
        if !is_environment_variable_name(&key_name) {
            return Err(GatewayError::InvalidJsonMessage(format!(
                "vault key {key_name} must be a valid environment variable name for Claude managed agents"
            )));
        }
        credentials.push(EnvironmentVaultCredential {
            name: key_name,
            value: value.to_owned(),
        });
    }
    Ok(credentials)
}

fn agent_vault_key_names(created: &CreatedRuntimeSession) -> Vec<String> {
    let mut names = BTreeSet::new();
    for value in created
        .agent
        .vault_keys
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let value = value.trim();
        if !value.is_empty() {
            names.insert(value.to_owned());
        }
    }
    names.into_iter().collect()
}

pub(super) fn is_environment_variable_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

pub(super) fn stable_hash(input: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
