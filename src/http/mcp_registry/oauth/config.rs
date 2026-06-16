use crate::{
    db::mcp_servers::schema::McpServerRow, errors::GatewayError, proxy::credential_crypto,
};

pub(super) fn oauth_scopes(server: &McpServerRow) -> Result<Vec<String>, GatewayError> {
    let scopes = server
        .mcp_info
        .pointer("/oauth/scopes")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if scopes.is_empty() {
        return Err(GatewayError::InvalidConfig(
            "MCP OAuth scopes are not configured in mcp_info.oauth.scopes".to_owned(),
        ));
    }
    Ok(scopes)
}

pub(super) fn oauth_resource(server: &McpServerRow) -> Option<String> {
    server
        .mcp_info
        .pointer("/oauth/resource")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(super) fn oauth_client_value(
    server: &McpServerRow,
    enc_key: &str,
    names: &[&str],
) -> Option<String> {
    names.iter().find_map(|name| {
        server
            .credentials
            .get(*name)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|raw| {
                credential_crypto::decrypt_value(raw, enc_key).unwrap_or_else(|_| raw.to_owned())
            })
    })
}

pub(super) fn required_server_url<'a>(
    value: Option<&'a str>,
    message: &str,
) -> Result<&'a str, GatewayError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| GatewayError::InvalidConfig(message.to_owned()))
}
