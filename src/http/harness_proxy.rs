use std::sync::Arc;

use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{
        header::{ACCEPT, CACHE_CONTROL, CONTENT_TYPE},
        HeaderMap, HeaderName, HeaderValue, Method, StatusCode,
    },
    response::Response,
};
use futures_util::TryStreamExt;
use reqwest::Url;
use serde::Deserialize;

use crate::{
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

const TARGET_KEY_HEADER: &str = "x-lite-harness-target-key";

#[derive(Debug, Deserialize)]
pub struct ProxyQuery {
    base: String,
    key: Option<String>,
    target_key: Option<String>,
}

pub async fn proxy(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Query(query): Query<ProxyQuery>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, GatewayError> {
    require_proxy_auth(&headers, query.key.as_deref(), &state)?;

    let target = target_url(&query.base, &path)?;
    let mut request = state.http.request(reqwest_method(&method)?, target);

    for (name, value) in request_headers(&headers) {
        request = request.header(name, value);
    }

    if let Some(key) = target_key(&headers, query.target_key.as_deref()) {
        request = request.bearer_auth(key);
    }

    if !body.is_empty() {
        request = request.body(body);
    }

    let upstream = request.send().await.map_err(GatewayError::Upstream)?;
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = response_headers(upstream.headers());
    let body_stream = upstream.bytes_stream().map_err(std::io::Error::other);
    let mut response = Response::new(Body::from_stream(body_stream));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}

fn require_proxy_auth(
    headers: &HeaderMap,
    query_key: Option<&str>,
    state: &AppState,
) -> Result<(), GatewayError> {
    if require_any_gateway_key(headers, state).is_ok() {
        return Ok(());
    }

    let Some(master_key) = state.config.general_settings.master_key.as_deref() else {
        return Ok(());
    };
    if query_key == Some(master_key) {
        return Ok(());
    }
    if query_key.is_some_and(|key| state.api_keys.accepts(key)) {
        return Ok(());
    }

    Err(GatewayError::Unauthorized)
}

fn target_url(base: &str, path: &str) -> Result<Url, GatewayError> {
    let trimmed = base.trim();
    if trimmed.is_empty() {
        return Err(GatewayError::InvalidJsonMessage(
            "harness proxy base URL is required".to_owned(),
        ));
    }

    let mut url = Url::parse(trimmed)
        .or_else(|_| Url::parse(&format!("http://{trimmed}")))
        .map_err(|_| {
            GatewayError::InvalidJsonMessage("invalid harness proxy base URL".to_owned())
        })?;

    if !matches!(url.scheme(), "http" | "https") {
        return Err(GatewayError::InvalidJsonMessage(
            "harness proxy base URL must use http or https".to_owned(),
        ));
    }

    let base_path = url.path().trim_end_matches('/');
    let suffix = path.trim_start_matches('/');
    let next_path = if base_path.is_empty() || base_path == "/" {
        format!("/{suffix}")
    } else if suffix.is_empty() {
        base_path.to_owned()
    } else {
        format!("{base_path}/{suffix}")
    };
    url.set_path(&next_path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn reqwest_method(method: &Method) -> Result<reqwest::Method, GatewayError> {
    reqwest::Method::from_bytes(method.as_str().as_bytes())
        .map_err(|_| GatewayError::InvalidJsonMessage("invalid harness proxy method".to_owned()))
}

fn request_headers(headers: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    [ACCEPT, CONTENT_TYPE]
        .into_iter()
        .filter_map(|name| headers.get(&name).map(|value| (name, value.clone())))
        .collect()
}

fn target_key<'a>(headers: &'a HeaderMap, query_key: Option<&'a str>) -> Option<&'a str> {
    headers
        .get(TARGET_KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .or(query_key)
        .map(str::trim)
        .filter(|key| !key.is_empty())
}

fn response_headers(headers: &reqwest::header::HeaderMap) -> HeaderMap {
    let mut copied = HeaderMap::new();
    for name in [CONTENT_TYPE, CACHE_CONTROL] {
        if let Some(value) = headers
            .get(name.as_str())
            .and_then(|value| HeaderValue::from_bytes(value.as_bytes()).ok())
        {
            copied.insert(name, value);
        }
    }
    copied
}
