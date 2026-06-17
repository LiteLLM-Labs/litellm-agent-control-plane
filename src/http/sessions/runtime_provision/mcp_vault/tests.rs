use serde_json::json;
use std::collections::BTreeSet;

use super::{
    anthropic_v1_base,
    credential::{
        gateway_mcp_credentials, is_environment_variable_name, EnvironmentVaultCredential,
        VaultCredential,
    },
    store::{
        stored_credential_changed, stored_credential_fingerprints, stored_credential_keys,
        StoredVault,
    },
};
use crate::{
    agents::config::E2bSandboxParams,
    proxy::{
        config::{GatewayConfig, GeneralSettings},
        state::AppState,
    },
    sdk::{providers::ProviderRegistry, routing::Router as ModelRouter},
};

#[test]
fn collects_gateway_mcp_credentials() {
    let state = state("https://gateway.example.com", Some("sk-master"));
    let credentials = gateway_mcp_credentials(
        &state,
        &[
            json!({
                "name": "gmail",
                "url": "https://gateway.example.com/mcp_gmail/mcp",
                "authorization_token": "sk-scoped"
            }),
            json!({
                "name": "platform",
                "url": "https://gateway.example.com/mcp/platform/agent_1?session_id=ses_1"
            }),
            json!({
                "name": "external",
                "url": "https://mcp.example.com/mcp",
                "authorization_token": "external-token"
            }),
        ],
    );

    assert_eq!(credentials.len(), 2);
    assert_eq!(
        credentials[0].url,
        "https://gateway.example.com/mcp/platform/agent_1?session_id=ses_1"
    );
    assert_eq!(credentials[0].token, "sk-master");
    assert_eq!(
        credentials[1].url,
        "https://gateway.example.com/mcp_gmail/mcp"
    );
    assert_eq!(credentials[1].token, "sk-scoped");
}

#[test]
fn normalizes_anthropic_v1_base() {
    assert_eq!(
        anthropic_v1_base("https://api.anthropic.com"),
        "https://api.anthropic.com/v1"
    );
    assert_eq!(
        anthropic_v1_base("https://api.anthropic.com/v1/"),
        "https://api.anthropic.com/v1"
    );
}

#[test]
fn builds_environment_variable_credential_body() {
    let credential = VaultCredential::EnvironmentVariable(EnvironmentVaultCredential {
        name: "BROWSER_USE_API_KEY".to_owned(),
        value: "secret".to_owned(),
    });

    assert_eq!(
        credential.auth(),
        json!({
            "type": "environment_variable",
            "secret_name": "BROWSER_USE_API_KEY",
            "secret_value": "secret"
        })
    );
    assert_eq!(credential.storage_key(), "env:BROWSER_USE_API_KEY");
}

#[test]
fn loads_legacy_and_current_stored_credential_keys() {
    let keys = stored_credential_keys(&json!({
        "credential_keys": ["env:BROWSER_USE_API_KEY"],
        "credential_urls": ["https://gateway.example.com/mcp_gmail/mcp"]
    }));

    assert_eq!(
        keys,
        BTreeSet::from([
            "env:BROWSER_USE_API_KEY".to_owned(),
            "mcp:https://gateway.example.com/mcp_gmail/mcp".to_owned()
        ])
    );
}

#[test]
fn loads_stored_credential_fingerprints() {
    let fingerprints = stored_credential_fingerprints(&json!({
        "credential_fingerprints": {
            "env:BROWSER_USE_API_KEY": "abc123"
        }
    }));

    assert_eq!(
        fingerprints
            .get("env:BROWSER_USE_API_KEY")
            .map(String::as_str),
        Some("abc123")
    );
}

#[test]
fn detects_rotated_stored_credentials() {
    let old = VaultCredential::EnvironmentVariable(EnvironmentVaultCredential {
        name: "BROWSER_USE_API_KEY".to_owned(),
        value: "old".to_owned(),
    });
    let new = VaultCredential::EnvironmentVariable(EnvironmentVaultCredential {
        name: "BROWSER_USE_API_KEY".to_owned(),
        value: "new".to_owned(),
    });
    let stored = StoredVault {
        vault_id: Some("vault_1".to_owned()),
        credential_keys: BTreeSet::from([old.storage_key()]),
        credential_fingerprints: [(old.storage_key(), old.fingerprint())].into(),
    };

    assert!(stored_credential_changed(&stored, &[new]));
}

#[test]
fn detects_removed_stored_credentials() {
    let old = VaultCredential::EnvironmentVariable(EnvironmentVaultCredential {
        name: "OLD_API_KEY".to_owned(),
        value: "old".to_owned(),
    });
    let current = VaultCredential::EnvironmentVariable(EnvironmentVaultCredential {
        name: "CURRENT_API_KEY".to_owned(),
        value: "current".to_owned(),
    });
    let stored = StoredVault {
        vault_id: Some("vault_1".to_owned()),
        credential_keys: BTreeSet::from([old.storage_key(), current.storage_key()]),
        credential_fingerprints: [
            (old.storage_key(), old.fingerprint()),
            (current.storage_key(), current.fingerprint()),
        ]
        .into(),
    };

    assert!(stored_credential_changed(&stored, &[current]));
}

#[test]
fn validates_environment_variable_names() {
    assert!(is_environment_variable_name("BROWSER_USE_API_KEY"));
    assert!(is_environment_variable_name("_TOKEN"));
    assert!(!is_environment_variable_name("1TOKEN"));
    assert!(!is_environment_variable_name("browser-use-api-key"));
    assert!(!is_environment_variable_name(""));
}

fn state(proxy_base_url: &str, master_key: Option<&str>) -> AppState {
    let config = config(proxy_base_url, master_key);
    let router = ModelRouter::from_config(&empty_config(), &ProviderRegistry::new()).unwrap();
    AppState::new(
        config,
        router,
        AppState::build_http_client().unwrap(),
        Default::default(),
        None,
    )
    .unwrap()
}

fn config(proxy_base_url: &str, master_key: Option<&str>) -> GatewayConfig {
    GatewayConfig {
        model_list: Vec::new(),
        mcp_servers: Default::default(),
        general_settings: GeneralSettings {
            master_key: master_key.map(str::to_owned),
            public_base_url: Some(proxy_base_url.to_owned()),
            e2b_sandbox_params: E2bSandboxParams {
                e2b_api_key: None,
                e2b_template: "litellm-4gb".to_owned(),
                timeout_seconds: 1800,
                workspace_dir: "/workspace".to_owned(),
                e2b_api_base: "https://e2b.example.com".to_owned(),
                envs: Default::default(),
            },
            ..Default::default()
        },
        slack: Default::default(),
        agents: Vec::new(),
    }
}

fn empty_config() -> GatewayConfig {
    GatewayConfig {
        model_list: Vec::new(),
        mcp_servers: Default::default(),
        general_settings: GeneralSettings::default(),
        slack: Default::default(),
        agents: Vec::new(),
    }
}
