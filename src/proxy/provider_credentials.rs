use serde::Serialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::credentials,
    errors::GatewayError,
    proxy::{config::GatewayConfig, credential_crypto},
};

pub const ANTHROPIC_PROVIDER_ID: &str = "anthropic";
pub const CURSOR_PROVIDER_ID: &str = "cursor";
pub const GEMINI_PROVIDER_ID: &str = "gemini";
pub const OPENCODE_PROVIDER_ID: &str = "opencode";
pub const OPENAI_PROVIDER_ID: &str = "openai";
const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
const DEFAULT_CURSOR_BASE_URL: &str = "https://api.cursor.com";
const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com";
const DEFAULT_OPENCODE_BASE_URL: &str = "http://127.0.0.1:4096";
const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com";

#[derive(Debug, Clone, Copy)]
pub struct ProviderCatalogEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub default_base_url: &'static str,
    pub category: ProviderCategory,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCategory {
    Model,
    Runtime,
}

pub const PROVIDER_CATALOG: &[ProviderCatalogEntry] = &[
    ProviderCatalogEntry {
        id: ANTHROPIC_PROVIDER_ID,
        name: "Anthropic",
        description: "Claude models through the Anthropic Messages API",
        default_base_url: DEFAULT_ANTHROPIC_BASE_URL,
        category: ProviderCategory::Model,
    },
    ProviderCatalogEntry {
        id: OPENAI_PROVIDER_ID,
        name: "OpenAI",
        description: "GPT models through the OpenAI Responses API",
        default_base_url: DEFAULT_OPENAI_BASE_URL,
        category: ProviderCategory::Model,
    },
    ProviderCatalogEntry {
        id: CURSOR_PROVIDER_ID,
        name: "Cursor",
        description: "Cursor background agents through the Cursor API",
        default_base_url: DEFAULT_CURSOR_BASE_URL,
        category: ProviderCategory::Runtime,
    },
    ProviderCatalogEntry {
        id: GEMINI_PROVIDER_ID,
        name: "Gemini",
        description: "Gemini Antigravity managed agents through the Gemini API",
        default_base_url: DEFAULT_GEMINI_BASE_URL,
        category: ProviderCategory::Runtime,
    },
    ProviderCatalogEntry {
        id: OPENCODE_PROVIDER_ID,
        name: "OpenCode",
        description: "OpenCode server sessions through the local runtime API",
        default_base_url: DEFAULT_OPENCODE_BASE_URL,
        category: ProviderCategory::Runtime,
    },
];

#[derive(Debug, Clone)]
pub struct ProviderCredential {
    pub api_key: String,
    pub api_base: String,
}

#[derive(Debug, Clone)]
pub struct ProviderCredentialInput {
    pub api_key: String,
    pub api_base: String,
}

pub fn credential_name(provider_id: &str) -> String {
    format!("provider:{provider_id}")
}

pub fn catalog_entry(provider_id: &str) -> Result<ProviderCatalogEntry, GatewayError> {
    PROVIDER_CATALOG
        .iter()
        .copied()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| GatewayError::NotFound(format!("provider not found: {provider_id}")))
}

pub async fn save(
    pool: &PgPool,
    config: &GatewayConfig,
    provider_id: &str,
    input: ProviderCredentialInput,
) -> Result<(), GatewayError> {
    let provider = catalog_entry(provider_id)?;
    let key = credential_crypto::encryption_key(config.general_settings.master_key.as_deref())?;
    let values = json!({
        "api_key": credential_crypto::encrypt_value(&input.api_key, &key)?,
        "api_base": credential_crypto::encrypt_value(&input.api_base, &key)?,
    });
    let info = json!({
        "custom_llm_provider": provider.id,
        "source": "litellm-rust-ui",
    });
    credentials::upsert(pool, &credential_name(provider.id), values, info, "ui").await
}

pub async fn load(
    pool: &PgPool,
    config: &GatewayConfig,
    provider_id: &str,
) -> Result<Option<ProviderCredential>, GatewayError> {
    let Some(row) = credentials::get_by_name(pool, &credential_name(provider_id)).await? else {
        return Ok(None);
    };
    let key = credential_crypto::encryption_key(config.general_settings.master_key.as_deref())?;
    let values = row.credential_values.as_object().ok_or_else(|| {
        GatewayError::InvalidConfig("credential_values must be an object".to_owned())
    })?;
    Ok(Some(ProviderCredential {
        api_key: decrypt_field(values, "api_key", &key)?,
        api_base: decrypt_field(values, "api_base", &key)?,
    }))
}

pub fn mask_api_key(api_key: &str) -> String {
    let trimmed = api_key.trim();
    if trimmed.len() <= 12 {
        return "Configured".to_owned();
    }
    format!("{}...{}", &trimmed[..7], &trimmed[trimmed.len() - 4..])
}

fn decrypt_field(
    values: &serde_json::Map<String, Value>,
    field: &str,
    key: &str,
) -> Result<String, GatewayError> {
    let encrypted = values
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| GatewayError::InvalidConfig(format!("credential is missing {field}")))?;
    credential_crypto::decrypt_value(encrypted, key)
}

#[cfg(test)]
mod tests {
    use super::catalog_entry;

    #[test]
    fn catalog_includes_openai() {
        let provider = catalog_entry("openai").unwrap();
        assert_eq!(provider.name, "OpenAI");
        assert_eq!(provider.default_base_url, "https://api.openai.com");
    }

    #[test]
    fn catalog_includes_agent_runtime_providers() {
        let provider = catalog_entry("cursor").unwrap();
        assert_eq!(provider.name, "Cursor");
        assert_eq!(provider.default_base_url, "https://api.cursor.com");

        let provider = catalog_entry("opencode").unwrap();
        assert_eq!(provider.name, "OpenCode");
        assert_eq!(provider.default_base_url, "http://127.0.0.1:4096");

        let provider = catalog_entry("gemini").unwrap();
        assert_eq!(provider.name, "Gemini");
        assert_eq!(
            provider.default_base_url,
            "https://generativelanguage.googleapis.com"
        );
    }
}
