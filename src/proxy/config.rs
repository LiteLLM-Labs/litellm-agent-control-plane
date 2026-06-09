use std::{fs, path::Path};

use crate::{
    agents::config::validate_agents,
    errors::GatewayError,
    proxy::mcp_config::{is_mcp_sequence_error, validate_mcp_servers},
};

pub use crate::proxy::config_types::{
    GatewayConfig, GeneralSettings, LiteLlmParams, McpServersConfig, ModelEntry, SlackSettings,
};
pub use crate::proxy::mcp_config::{McpAuthType, McpServerEntry, McpTransport};

pub fn load_config(path: &Path) -> Result<GatewayConfig, GatewayError> {
    let raw = fs::read_to_string(path)?;
    let mut config: GatewayConfig = serde_yaml::from_str(&raw).map_err(|error| {
        // `mcp_servers` changed from a list to a dict keyed by server name.
        // serde reports this as an "invalid type: sequence" error; translate it
        // into actionable guidance for anyone upgrading an old config.
        if is_mcp_sequence_error(&raw, &error) {
            GatewayError::InvalidConfig(
                "mcp_servers is now a dict keyed by server name (was a list). \
                 See docs/mcp.md for the new format."
                    .to_owned(),
            )
        } else {
            GatewayError::from(error)
        }
    })?;
    expand_env(&mut config)?;
    validate(&config)?;
    Ok(config)
}

pub fn expand_env_value(value: &str) -> Result<String, GatewayError> {
    let Some(name) = value.strip_prefix("os.environ/") else {
        return Ok(value.to_owned());
    };

    std::env::var(name).map_err(|_| {
        GatewayError::InvalidConfig(format!("environment variable {name} is required"))
    })
}

fn expand_env(config: &mut GatewayConfig) -> Result<(), GatewayError> {
    if let Some(master_key) = config.general_settings.master_key.as_deref() {
        config.general_settings.master_key = Some(expand_env_value(master_key)?);
    }
    if let Some(database_url) = config.general_settings.database_url.as_deref() {
        config.general_settings.database_url = Some(expand_env_value(database_url)?);
    }
    if let Some(public_base_url) = config.general_settings.public_base_url.as_deref() {
        config.general_settings.public_base_url = Some(expand_env_value(public_base_url)?);
    }
    if let Some(proxy_base_url) = config.mcp_servers.proxy_base_url.as_deref() {
        config.mcp_servers.proxy_base_url = Some(expand_env_value(proxy_base_url)?);
    } else if config.general_settings.public_base_url.is_none() {
        config.mcp_servers.proxy_base_url = first_non_empty_env([
            "LITELLM_PROXY_BASE_URL",
            "LITELLM_PUBLIC_BASE_URL",
            "RENDER_EXTERNAL_URL",
        ]);
    }
    config.slack.api_base_url = expand_env_value(&config.slack.api_base_url)?;

    for entry in &mut config.model_list {
        if let Some(api_key) = entry.litellm_params.api_key.as_deref() {
            entry.litellm_params.api_key = Some(expand_env_value(api_key)?);
        }
        if let Some(api_base) = entry.litellm_params.api_base.as_deref() {
            entry.litellm_params.api_base = Some(expand_env_value(api_base)?);
        }
    }

    for server in config.mcp_servers.values_mut() {
        server.url = expand_env_value(&server.url)?;
        if let Some(auth_value) = server.auth_value.as_deref() {
            server.auth_value = Some(expand_env_value(auth_value)?);
        }
        for value in server.static_headers.values_mut() {
            *value = expand_env_value(value)?;
        }
    }

    if let Some(api_key) = config
        .general_settings
        .e2b_sandbox_params
        .e2b_api_key
        .as_deref()
    {
        config.general_settings.e2b_sandbox_params.e2b_api_key = Some(expand_env_value(api_key)?);
    }
    for value in config.general_settings.e2b_sandbox_params.envs.values_mut() {
        *value = expand_env_value(value)?;
    }

    Ok(())
}

fn first_non_empty_env(names: [&str; 3]) -> Option<String> {
    names.into_iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
    })
}

fn validate(config: &GatewayConfig) -> Result<(), GatewayError> {
    validate_required_surface(config)?;
    validate_base_url(
        "mcp_servers.proxy_base_url",
        config.mcp_servers.proxy_base_url(),
    )?;
    validate_base_url(
        "general_settings.public_base_url",
        config.general_settings.public_base_url.as_deref(),
    )?;
    validate_model_entries(
        &config.model_list,
        config.general_settings.database_url.is_some(),
    )?;
    validate_mcp_servers(&config.mcp_servers)?;
    validate_agents(
        &config.agents,
        config.general_settings.sandbox_choice.as_deref(),
        &config.general_settings.e2b_sandbox_params,
    )?;
    Ok(())
}

fn validate_base_url(field: &str, value: Option<&str>) -> Result<(), GatewayError> {
    validate_http_base_url(field, value).map_err(GatewayError::InvalidConfig)
}

pub fn validate_http_base_url(field: &str, value: Option<&str>) -> Result<(), String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let url = reqwest::Url::parse(value)
        .map_err(|_| format!("{field} must be an absolute http(s) URL"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(format!("{field} must be an absolute http(s) URL"));
    }
    Ok(())
}

fn validate_required_surface(config: &GatewayConfig) -> Result<(), GatewayError> {
    if config.model_list.is_empty()
        && config.mcp_servers.is_empty()
        && config.agents.is_empty()
        && config.general_settings.database_url.is_none()
    {
        return Err(GatewayError::InvalidConfig(
            "model_list, mcp_servers, agents, or general_settings.database_url must contain at least one entry".to_owned(),
        ));
    }
    Ok(())
}

fn validate_model_entries(
    entries: &[ModelEntry],
    has_database_url: bool,
) -> Result<(), GatewayError> {
    for entry in entries {
        if entry.model_name.trim().is_empty() {
            return Err(GatewayError::InvalidConfig(
                "model_name cannot be empty".to_owned(),
            ));
        }

        if !entry.litellm_params.model.contains('/') {
            return Err(GatewayError::InvalidConfig(format!(
                "model must include provider prefix (e.g. anthropic/...), got {}",
                entry.litellm_params.model
            )));
        }

        if entry
            .litellm_params
            .api_key
            .as_deref()
            .unwrap_or("")
            .is_empty()
            && !has_database_url
        {
            return Err(GatewayError::InvalidConfig(format!(
                "{} is missing litellm_params.api_key",
                entry.model_name
            )));
        }
    }
    Ok(())
}
