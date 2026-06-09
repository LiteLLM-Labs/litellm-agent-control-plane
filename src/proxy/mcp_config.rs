use std::collections::HashMap;

use serde::Deserialize;

use crate::errors::GatewayError;

#[derive(Debug, Clone, Deserialize)]
pub struct McpServerEntry {
    pub url: String,

    #[serde(default)]
    pub transport: McpTransport,

    #[serde(default)]
    pub auth_type: McpAuthType,

    #[serde(default, alias = "authentication_token")]
    pub auth_value: Option<String>,

    #[serde(default)]
    pub static_headers: HashMap<String, String>,

    #[serde(default)]
    pub extra_headers: Vec<String>,

    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    #[default]
    Http,
    Sse,
    Stdio,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpAuthType {
    #[default]
    None,
    ApiKey,
    BearerToken,
    Basic,
    Authorization,
    Token,
    Oauth2,
    Oauth2TokenExchange,
    AwsSigv4,
}

impl McpAuthType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ApiKey => "api_key",
            Self::BearerToken => "bearer_token",
            Self::Basic => "basic",
            Self::Authorization => "authorization",
            Self::Token => "token",
            Self::Oauth2 => "oauth2",
            Self::Oauth2TokenExchange => "oauth2_token_exchange",
            Self::AwsSigv4 => "aws_sigv4",
        }
    }
}

pub fn is_mcp_sequence_error(raw: &str, error: &serde_yaml::Error) -> bool {
    if !error.to_string().contains("invalid type: sequence") {
        return false;
    }
    let mut in_mcp = false;
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("mcp_servers:") {
            if rest.trim_start().starts_with('[') {
                return true;
            }
            in_mcp = true;
            continue;
        }
        if in_mcp {
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if line.starts_with(char::is_whitespace) && trimmed.starts_with("- ") {
                return true;
            }
            if !line.starts_with(char::is_whitespace) {
                in_mcp = false;
            }
        }
    }
    false
}

pub fn validate_mcp_servers(servers: &HashMap<String, McpServerEntry>) -> Result<(), GatewayError> {
    for (name, server) in servers {
        validate_server_name(name)?;
        validate_server(name, server)?;
    }
    Ok(())
}

fn validate_server_name(name: &str) -> Result<(), GatewayError> {
    if name.trim().is_empty() {
        return Err(GatewayError::InvalidConfig(
            "mcp server name cannot be empty".to_owned(),
        ));
    }
    Ok(())
}

fn validate_server(name: &str, server: &McpServerEntry) -> Result<(), GatewayError> {
    if server.url.trim().is_empty() {
        return Err(GatewayError::InvalidConfig(format!(
            "{name} is missing mcp_servers.url"
        )));
    }
    if server.transport != McpTransport::Http {
        return Err(GatewayError::InvalidConfig(format!(
            "{name}: only 'http' transport is supported"
        )));
    }
    validate_auth(name, server)
}

fn validate_auth(name: &str, server: &McpServerEntry) -> Result<(), GatewayError> {
    match server.auth_type {
        McpAuthType::Oauth2 | McpAuthType::Oauth2TokenExchange | McpAuthType::AwsSigv4 => {
            Err(GatewayError::InvalidConfig(format!(
                "{name}: auth_type '{}' not yet supported",
                server.auth_type.as_str()
            )))
        }
        McpAuthType::None => Ok(()),
        _ if server.auth_value.as_deref().unwrap_or("").is_empty() => {
            Err(GatewayError::InvalidConfig(format!(
                "{name}: auth_type '{}' requires auth_value",
                server.auth_type.as_str()
            )))
        }
        _ => Ok(()),
    }
}
