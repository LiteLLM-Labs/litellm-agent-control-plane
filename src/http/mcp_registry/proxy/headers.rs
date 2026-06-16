use std::collections::HashMap;

use axum::http::{
    header::{ACCEPT, CONTENT_TYPE},
    HeaderMap, HeaderName, HeaderValue, Method,
};

use crate::errors::GatewayError;

use super::super::substitute_vars;

pub(super) fn build_outbound_request(
    client: &reqwest::Client,
    method: Method,
    target_url: &str,
    inbound: &HeaderMap,
    static_headers: &serde_json::Value,
    vars: &HashMap<String, String>,
) -> Result<reqwest::RequestBuilder, GatewayError> {
    let reqwest_method = reqwest::Method::from_bytes(method.as_str().as_bytes())
        .map_err(|_| GatewayError::InvalidJsonMessage("invalid HTTP method".to_owned()))?;
    let mut req = client.request(reqwest_method, target_url);
    for (name, value) in forward_headers(inbound) {
        req = req.header(name, value);
    }
    if let Some(obj) = static_headers.as_object() {
        for (name, val) in obj {
            if let Some((name, value)) = static_header(name, val, vars) {
                req = req.header(name, value);
            }
        }
    }
    Ok(req)
}

pub(super) fn has_static_headers(static_headers: &serde_json::Value) -> bool {
    static_headers.as_object().is_some_and(|o| !o.is_empty())
}

pub(super) fn apply_auth(
    req: reqwest::RequestBuilder,
    auth_type: Option<&str>,
    credential: &str,
) -> reqwest::RequestBuilder {
    match auth_type {
        Some("bearer_token") | Some("oauth2") => {
            req.header("Authorization", format!("Bearer {credential}"))
        }
        Some("api_key") => req.header("x-api-key", credential),
        Some("basic") => req.header("Authorization", format!("Basic {credential}")),
        _ => req,
    }
}

pub(super) fn copy_response_headers(headers: &reqwest::header::HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    for name_str in [
        CONTENT_TYPE.as_str(),
        "cache-control",
        "connect-protocol-version",
        "connect-content-encoding",
    ] {
        if let Some((name, value)) = response_header(headers, name_str) {
            out.insert(name, value);
        }
    }
    out
}

fn forward_headers(headers: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    const CONNECT_PROTOCOL_VERSION: &str = "connect-protocol-version";

    let mut out = Vec::new();
    for name in [ACCEPT, CONTENT_TYPE] {
        if let Some(value) = headers.get(&name) {
            out.push((name, value.clone()));
        }
    }
    if let Some(value) = headers.get(CONNECT_PROTOCOL_VERSION) {
        if let Ok(name) = HeaderName::from_bytes(CONNECT_PROTOCOL_VERSION.as_bytes()) {
            out.push((name, value.clone()));
        }
    }
    out
}

fn static_header(
    name: &str,
    value: &serde_json::Value,
    vars: &HashMap<String, String>,
) -> Option<(HeaderName, HeaderValue)> {
    let resolved = substitute_vars(value.as_str()?, vars);
    Some((
        HeaderName::from_bytes(name.as_bytes()).ok()?,
        HeaderValue::from_str(&resolved).ok()?,
    ))
}

fn response_header(
    headers: &reqwest::header::HeaderMap,
    name_str: &str,
) -> Option<(HeaderName, HeaderValue)> {
    Some((
        HeaderName::from_bytes(name_str.as_bytes()).ok()?,
        HeaderValue::from_bytes(headers.get(name_str)?.as_bytes()).ok()?,
    ))
}
