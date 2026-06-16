use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::{header::COOKIE, HeaderMap};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::errors::GatewayError;

type HmacSha256 = Hmac<Sha256>;

const STATE_TTL_MS: i64 = 10 * 60 * 1000;
const STATE_TTL_MS_SECONDS: i64 = STATE_TTL_MS / 1000;
const CALLBACK_COOKIE: &str = "lap_mcp_oauth_state";

#[derive(Debug, Deserialize, Serialize)]
pub(super) struct SignedOAuthState {
    pub server_id: String,
    pub user_id: String,
    pub redirect_after: Option<String>,
    pub redirect_uri: String,
    pub nonce: String,
    pub iat_ms: i64,
}

pub(super) fn authorization_url(
    base_url: &str,
    client_id: &str,
    redirect_uri: &str,
    scopes: &[String],
    resource: Option<&str>,
    state_value: &str,
) -> Result<String, GatewayError> {
    let mut url = Url::parse(base_url).map_err(|error| {
        GatewayError::InvalidConfig(format!("invalid MCP OAuth authorization_url: {error}"))
    })?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &scopes.join(" "))
        .append_pair("state", state_value);
    if let Some(resource) = resource {
        url.query_pairs_mut().append_pair("resource", resource);
    }
    url.query_pairs_mut()
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("include_granted_scopes", "true");
    Ok(url.to_string())
}

pub(super) fn encode_state(state: &SignedOAuthState, secret: &str) -> Result<String, GatewayError> {
    let payload = serde_json::to_vec(state).map_err(GatewayError::InvalidJson)?;
    let payload = URL_SAFE_NO_PAD.encode(payload);
    let signature = sign_state(&payload, secret)?;
    Ok(format!("{payload}.{signature}"))
}

pub(super) fn decode_state(value: &str, secret: &str) -> Result<SignedOAuthState, GatewayError> {
    let (payload, signature) = value.split_once('.').ok_or(GatewayError::Unauthorized)?;
    verify_state(payload, signature, secret)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| GatewayError::Unauthorized)?;
    let state = serde_json::from_slice::<SignedOAuthState>(&payload)
        .map_err(|_| GatewayError::Unauthorized)?;
    if now_ms().saturating_sub(state.iat_ms) > STATE_TTL_MS {
        return Err(GatewayError::Unauthorized);
    }
    Ok(state)
}

pub(super) fn redirect_target(
    redirect_after: &str,
    status: &str,
    server_id: &str,
    error: Option<&str>,
) -> String {
    let mut params = vec![
        ("mcp_oauth", status.to_owned()),
        ("server_id", server_id.to_owned()),
    ];
    if let Some(error) = error {
        params.push(("error", error.to_owned()));
    }
    let query = params
        .into_iter()
        .map(|(key, value)| format!("{key}={}", query_escape(&value)))
        .collect::<Vec<_>>()
        .join("&");
    let separator = if redirect_after.contains('?') {
        "&"
    } else {
        "?"
    };
    format!("{redirect_after}{separator}{query}")
}

pub(super) fn callback_cookie(state_value: &str, redirect_uri: &str) -> String {
    let secure = Url::parse(redirect_uri)
        .ok()
        .is_some_and(|url| url.scheme() == "https");
    format!(
        "{CALLBACK_COOKIE}={state_value}; Path=/v1/mcp/oauth; HttpOnly; SameSite=Lax; Max-Age={STATE_TTL_MS_SECONDS}{}",
        if secure { "; Secure" } else { "" }
    )
}

pub(super) fn clear_callback_cookie() -> &'static str {
    "lap_mcp_oauth_state=; Path=/v1/mcp/oauth; HttpOnly; SameSite=Lax; Max-Age=0"
}

pub(super) fn callback_cookie_matches(headers: &HeaderMap, state_value: &str) -> bool {
    headers.get_all(COOKIE).iter().any(|value| {
        let Ok(value) = value.to_str() else {
            return false;
        };
        value.split(';').any(|part| {
            let Some((name, value)) = part.trim().split_once('=') else {
                return false;
            };
            name == CALLBACK_COOKIE && value == state_value
        })
    })
}

pub(super) fn safe_redirect_after(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| {
            value.starts_with('/')
                && !value.starts_with("//")
                && !value.contains('\n')
                && !value.contains('\r')
        })
        .unwrap_or("/integrations")
        .to_owned()
}

pub(super) fn origin(headers: &HeaderMap) -> String {
    let proto = forwarded_header(headers, "x-forwarded-proto")
        .or_else(|| forwarded_header(headers, "x-forwarded-protocol"))
        .unwrap_or("http");
    let host = forwarded_header(headers, "x-forwarded-host")
        .or_else(|| forwarded_header(headers, "host"))
        .unwrap_or("localhost");
    format!("{proto}://{host}")
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn sign_state(payload: &str, secret: &str) -> Result<String, GatewayError> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| {
        GatewayError::InvalidConfig("OAuth state signing key is invalid".to_owned())
    })?;
    mac.update(payload.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn verify_state(payload: &str, signature: &str, secret: &str) -> Result<(), GatewayError> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| {
        GatewayError::InvalidConfig("OAuth state signing key is invalid".to_owned())
    })?;
    mac.update(payload.as_bytes());
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| GatewayError::Unauthorized)?;
    mac.verify_slice(&signature)
        .map_err(|_| GatewayError::Unauthorized)
}

fn query_escape(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn forwarded_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(first_forwarded_value)
}

fn first_forwarded_value(value: &str) -> Option<&str> {
    value
        .split(',')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
