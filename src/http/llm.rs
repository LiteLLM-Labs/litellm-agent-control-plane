//! The only place that does outbound networking to providers.

use axum::{body::Body, http::HeaderMap, response::Response};
use futures_util::StreamExt;
use reqwest::{Client, Response as UpstreamResponse};

use crate::{
    callbacks::{
        standard_logging::{error_information, response_value, StandardLoggingPayload},
        CallbackManager,
    },
    errors::GatewayError,
    model_prices::ModelCostMap,
    sdk::providers::ProviderRequest,
};

const MAX_STREAM_CAPTURE_BYTES: usize = 1_000_000;

pub async fn send_request(
    http: &Client,
    url: String,
    prepared: ProviderRequest,
) -> Result<UpstreamResponse, GatewayError> {
    let mut req = http.post(url).body(prepared.body);
    for (name, value) in &prepared.headers {
        req = req.header(name, value);
    }
    req.send().await.map_err(GatewayError::Upstream)
}

pub async fn build_response(upstream: UpstreamResponse, headers: HeaderMap) -> Response {
    let status = upstream.status();
    let body_stream = upstream
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    let mut response = Response::new(Body::from_stream(body_stream));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

pub async fn build_logged_response(
    upstream: UpstreamResponse,
    headers: HeaderMap,
    stream: bool,
    mut payload: StandardLoggingPayload,
    callbacks: CallbackManager,
    prices: ModelCostMap,
) -> Result<Response, GatewayError> {
    let status = upstream.status();
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if stream {
        return Ok(streaming_response(
            upstream,
            headers,
            payload,
            callbacks,
            prices,
            content_type,
        ));
    }

    let bytes = upstream.bytes().await.map_err(|error| {
        payload.finish_error(error_information("upstream_body_error", error.to_string()));
        callbacks.on_error(payload.clone());
        GatewayError::Upstream(error)
    })?;
    let value = response_value(&bytes, content_type.as_deref());
    if status.is_success() {
        payload.finish_success(value, &prices);
        callbacks.on_success(payload);
    } else {
        let message = format!("upstream returned HTTP {status}: {}", body_preview(&bytes));
        payload.response = Some(value);
        payload.finish_error(error_information("upstream_http_error", message));
        callbacks.on_error(payload);
    }

    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}

fn streaming_response(
    upstream: UpstreamResponse,
    headers: HeaderMap,
    mut payload: StandardLoggingPayload,
    callbacks: CallbackManager,
    prices: ModelCostMap,
    content_type: Option<String>,
) -> Response {
    let status = upstream.status();
    let mut upstream_stream = upstream.bytes_stream();
    let body_stream = async_stream::stream! {
        let mut captured = Vec::new();
        while let Some(next) = upstream_stream.next().await {
            match next {
                Ok(bytes) => {
                    let remaining = MAX_STREAM_CAPTURE_BYTES.saturating_sub(captured.len());
                    captured.extend(bytes.iter().take(remaining));
                    yield Ok::<_, std::io::Error>(bytes);
                }
                Err(error) => {
                    payload.finish_error(error_information("stream_error", error.to_string()));
                    callbacks.on_error(payload.clone());
                    yield Err::<_, std::io::Error>(std::io::Error::other(error));
                    return;
                }
            }
        }
        let value = response_value(&captured, content_type.as_deref());
        if status.is_success() {
            payload.finish_success(value, &prices);
            callbacks.on_success(payload);
        } else {
            let message = format!("upstream returned HTTP {status}: {}", body_preview(&captured));
            payload.response = Some(value);
            payload.finish_error(error_information("upstream_http_error", message));
            callbacks.on_error(payload);
        }
    };
    let mut response = Response::new(Body::from_stream(body_stream));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

fn body_preview(bytes: &[u8]) -> String {
    const MAX_PREVIEW_BYTES: usize = 4_096;
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_PREVIEW_BYTES)]).to_string()
}
