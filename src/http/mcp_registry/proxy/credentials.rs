use std::collections::HashMap;

use serde_json::Value;

use crate::{
    db::{credentials, mcp_servers::schema::McpServerRow},
    errors::GatewayError,
    proxy::{credential_crypto, state::AppState},
};

pub(super) async fn resolve_variables(
    pool: &sqlx::PgPool,
    server: &McpServerRow,
    user_id: &str,
    enc_key: &str,
) -> Result<HashMap<String, String>, GatewayError> {
    let mut map = HashMap::new();
    let Some(vars) = server.mcp_info.get("variables").and_then(Value::as_array) else {
        return Ok(map);
    };

    for var in vars {
        let Some(name) = var.get("name").and_then(Value::as_str) else {
            continue;
        };
        let value = if var.get("scope").and_then(Value::as_str) == Some("per_user") {
            resolve_user_variable(pool, &server.server_id, name, user_id, enc_key).await
        } else {
            resolve_instance_variable(server, name, enc_key)
        };
        if let Some(value) = value {
            map.insert(name.to_owned(), value);
        }
    }
    Ok(map)
}

pub(super) async fn resolve_auth_credential(
    state: &AppState,
    pool: &sqlx::PgPool,
    server: &McpServerRow,
    user_id: &str,
    enc_key: &str,
) -> Result<Option<String>, GatewayError> {
    match super::super::oauth::resolve_oauth_bearer_token(state, pool, server, user_id, enc_key)
        .await?
    {
        Some(value) => Ok(Some(value)),
        None => {
            let user = resolve_user_credential(pool, &server.server_id, user_id, enc_key).await?;
            Ok(user.or_else(|| resolve_server_credential(&server.credentials, enc_key)))
        }
    }
}

async fn resolve_user_variable(
    pool: &sqlx::PgPool,
    server_id: &str,
    name: &str,
    user_id: &str,
    enc_key: &str,
) -> Option<String> {
    let vault_key = format!("mcp_var:{server_id}:{name}");
    credentials::get_personal_by_name(pool, &vault_key, user_id)
        .await
        .ok()
        .flatten()
        .and_then(|row| decrypt_row_value(&row.credential_values, enc_key))
}

fn resolve_instance_variable(server: &McpServerRow, name: &str, enc_key: &str) -> Option<String> {
    server
        .credentials
        .get(name)
        .and_then(Value::as_str)
        .map(|raw| {
            credential_crypto::decrypt_value(raw, enc_key).unwrap_or_else(|_| raw.to_owned())
        })
}

async fn resolve_user_credential(
    pool: &sqlx::PgPool,
    server_id: &str,
    user_id: &str,
    enc_key: &str,
) -> Result<Option<String>, GatewayError> {
    let key_name = format!("mcp_user:{server_id}:{user_id}");
    let Some(row) = credentials::get_personal_by_name(pool, &key_name, user_id).await? else {
        return Ok(None);
    };
    let encrypted = row
        .credential_values
        .get("value")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let Some(encrypted) = encrypted else {
        return Ok(None);
    };
    credential_crypto::decrypt_value(encrypted, enc_key).map(Some)
}

fn resolve_server_credential(credentials: &Value, enc_key: &str) -> Option<String> {
    let obj = credentials.as_object()?;
    if let Some(encrypted) = obj.get("value").and_then(Value::as_str) {
        return credential_crypto::decrypt_value(encrypted, enc_key).ok();
    }
    obj.get("api_key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn decrypt_row_value(values: &Value, enc_key: &str) -> Option<String> {
    values
        .get("value")
        .and_then(Value::as_str)
        .and_then(|enc| credential_crypto::decrypt_value(enc, enc_key).ok())
}
