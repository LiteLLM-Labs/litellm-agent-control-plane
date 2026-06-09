use std::collections::HashMap;

use axum::http::{HeaderName, HeaderValue};
use base64::Engine;
use reqwest::Url;

use crate::{
    errors::GatewayError,
    proxy::config::{GatewayConfig, McpAuthType, McpServerEntry},
};

#[derive(Debug, Clone, Default)]
pub struct McpServerRegistry {
    servers: HashMap<String, McpServer>,
}

/// A resolved MCP server: URL parsed, auth header precomputed at config time so
/// the request path does no per-request auth work.
#[derive(Debug, Clone)]
pub struct McpServer {
    pub url: Url,
    /// Auth header to send upstream, or `None` for `auth_type: none`.
    pub auth_header: Option<(HeaderName, HeaderValue)>,
    /// Headers always sent upstream.
    pub static_headers: HashMap<String, String>,
    /// Lowercased inbound header names to forward upstream.
    pub extra_headers: Vec<String>,
}

impl McpServerRegistry {
    pub fn from_config(config: &GatewayConfig) -> Result<Self, GatewayError> {
        let mut servers = HashMap::with_capacity(config.mcp_servers.len());
        for (name, entry) in config.mcp_servers.iter() {
            servers.insert(name.clone(), McpServer::from_entry(name, entry)?);
        }
        Ok(Self { servers })
    }

    pub fn resolve(&self, server_id: &str) -> Result<&McpServer, GatewayError> {
        self.servers
            .get(server_id)
            .ok_or_else(|| GatewayError::UnknownMcpServer(server_id.to_owned()))
    }

    pub fn only_server_id(&self) -> Option<&str> {
        let mut keys = self.servers.keys();
        let first = keys.next()?;
        keys.next().is_none().then_some(first.as_str())
    }

    pub fn len(&self) -> usize {
        self.servers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.servers.is_empty()
    }
}

impl McpServer {
    fn from_entry(name: &str, entry: &McpServerEntry) -> Result<Self, GatewayError> {
        let url = entry.url.parse().map_err(|error| {
            GatewayError::InvalidConfig(format!("{name} has invalid mcp_servers.url: {error}"))
        })?;
        let auth_header = build_auth_header(name, entry.auth_type, entry.auth_value.as_deref())?;
        Ok(Self {
            url,
            auth_header,
            static_headers: entry.static_headers.clone(),
            extra_headers: entry
                .extra_headers
                .iter()
                .map(|h| h.to_ascii_lowercase())
                .collect(),
        })
    }
}

/// Build the upstream auth header for an MCP server, mirroring LiteLLM's
/// managed-transport `MCPClient._get_auth_headers`. `none` yields no header;
/// `oauth2`/`oauth2_token_exchange`/`aws_sigv4` are rejected earlier in config
/// validation and treated as a bug if they reach here.
fn build_auth_header(
    name: &str,
    auth_type: McpAuthType,
    auth_value: Option<&str>,
) -> Result<Option<(HeaderName, HeaderValue)>, GatewayError> {
    if auth_type == McpAuthType::None {
        return Ok(None);
    }

    // Non-none auth types require a value (enforced in config validation).
    let value = auth_value.unwrap_or_default();

    let (header_name, value_str): (HeaderName, String) = match auth_type {
        McpAuthType::BearerToken => (
            HeaderName::from_static("authorization"),
            format!("Bearer {value}"),
        ),
        McpAuthType::ApiKey => (HeaderName::from_static("x-api-key"), value.to_owned()),
        // LiteLLM's `to_basic_auth` base64-encodes the raw value at set-time, so
        // a config `auth_value: "user:pass"` must produce the encoded header.
        McpAuthType::Basic => (
            HeaderName::from_static("authorization"),
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(value)
            ),
        ),
        McpAuthType::Authorization => (HeaderName::from_static("authorization"), value.to_owned()),
        McpAuthType::Token => (
            HeaderName::from_static("authorization"),
            format!("token {value}"),
        ),
        McpAuthType::None
        | McpAuthType::Oauth2
        | McpAuthType::Oauth2TokenExchange
        | McpAuthType::AwsSigv4 => {
            return Err(GatewayError::InvalidConfig(format!(
                "{name}: auth_type '{}' not yet supported",
                auth_type.as_str()
            )));
        }
    };

    let header_value = HeaderValue::from_str(&value_str).map_err(|error| {
        GatewayError::InvalidConfig(format!("{name}: invalid auth_value for header: {error}"))
    })?;
    Ok(Some((header_name, header_value)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(auth_type: McpAuthType, value: &str) -> Option<(String, String)> {
        build_auth_header("t", auth_type, Some(value))
            .unwrap()
            .map(|(n, v)| (n.as_str().to_owned(), v.to_str().unwrap().to_owned()))
    }

    #[test]
    fn bearer_token_maps_to_authorization_bearer() {
        assert_eq!(
            header(McpAuthType::BearerToken, "abc"),
            Some(("authorization".to_owned(), "Bearer abc".to_owned()))
        );
    }

    #[test]
    fn api_key_maps_to_x_api_key_not_bearer() {
        assert_eq!(
            header(McpAuthType::ApiKey, "abc"),
            Some(("x-api-key".to_owned(), "abc".to_owned()))
        );
    }

    #[test]
    fn basic_base64_encodes_raw_value() {
        // base64("user:pw") == "dXNlcjpwdw=="
        assert_eq!(
            header(McpAuthType::Basic, "user:pw"),
            Some(("authorization".to_owned(), "Basic dXNlcjpwdw==".to_owned()))
        );
    }

    #[test]
    fn authorization_is_verbatim() {
        assert_eq!(
            header(McpAuthType::Authorization, "Custom xyz"),
            Some(("authorization".to_owned(), "Custom xyz".to_owned()))
        );
    }

    #[test]
    fn token_maps_to_authorization_token() {
        assert_eq!(
            header(McpAuthType::Token, "ghp_x"),
            Some(("authorization".to_owned(), "token ghp_x".to_owned()))
        );
    }

    #[test]
    fn none_yields_no_header() {
        assert_eq!(
            build_auth_header("t", McpAuthType::None, None).unwrap(),
            None
        );
    }
}
