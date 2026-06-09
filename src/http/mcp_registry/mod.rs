pub mod admin;
pub mod discover;
pub mod proxy;
pub mod public;
pub mod settings;
pub mod tools;
pub mod user_credentials;

use std::collections::HashMap;

use axum::http::HeaderMap;

use crate::{
    db::{credentials, mcp_servers::schema::McpServerRow},
    proxy::{credential_crypto, state::AppState},
};

/// Replace all `${VAR_NAME}` placeholders in `template` with values from `vars`.
pub(super) fn substitute_vars(template: &str, vars: &HashMap<String, String>) -> String {
    let mut result = template.to_owned();
    for (name, value) in vars {
        result = result.replace(&format!("${{{}}}", name), value);
    }
    result
}

/// Return the caller's user id for vault key operations.
///
/// Any authenticated caller may supply `x-user-id` to scope their personal
/// credentials. Falls back to `"default"` when the header is absent.
pub(super) fn caller_user_id(headers: &HeaderMap, _state: &AppState) -> String {
    headers
        .get("x-user-id")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| "default".to_owned())
}

/// Build a variable substitution map from a server's `mcp_info["variables"]` array.
pub(super) async fn build_vars_map(
    pool: &sqlx::PgPool,
    server: &McpServerRow,
    user_id: &str,
    enc_key: &str,
) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(vars) = server.mcp_info.get("variables").and_then(|v| v.as_array()) else {
        return map;
    };
    for var in vars {
        let Some(name) = var.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let scope = var
            .get("scope")
            .and_then(|v| v.as_str())
            .unwrap_or("instance");
        let value: Option<String> = if scope == "per_user" {
            let vault_key = format!("mcp_var:{}:{}", server.server_id, name);
            credentials::get_personal_by_name(pool, &vault_key, user_id)
                .await
                .ok()
                .flatten()
                .and_then(|row| {
                    row.credential_values
                        .get("value")
                        .and_then(|v| v.as_str())
                        .and_then(|enc| credential_crypto::decrypt_value(enc, enc_key).ok())
                })
        } else {
            server
                .credentials
                .get(name)
                .and_then(|v| v.as_str())
                .map(|raw| {
                    credential_crypto::decrypt_value(raw, enc_key)
                        .unwrap_or_else(|_| raw.to_owned())
                })
        };
        if let Some(v) = value {
            map.insert(name.to_owned(), v);
        }
    }
    map
}
