use std::sync::Arc;

use axum::{body::Bytes, extract::State, http::HeaderMap, response::Response};
use serde_json::Value;

use crate::{
    callbacks::standard_logging::{error_information, StandardLoggingPayload},
    errors::GatewayError,
    http::{credential_overrides, llm},
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
    sdk::routing::Route,
};

pub async fn messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, GatewayError> {
    require_any_gateway_key(&headers, &state).await?;

    let body: Value = serde_json::from_slice(&body).map_err(GatewayError::InvalidJson)?;
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or(GatewayError::MissingModel)?
        .to_owned();
    let route = credential_overrides::apply(&state, state.router.resolve(&model)?).await?;
    send_messages_request(state, headers, body, model, route).await
}

async fn send_messages_request(
    state: Arc<AppState>,
    headers: HeaderMap,
    body: Value,
    model: String,
    route: Route,
) -> Result<Response, GatewayError> {
    let prepared =
        route
            .handler
            .transform_messages_request(body.clone(), &route.deployment, &headers)?;
    let stream = prepared.stream;
    let mut payload = StandardLoggingPayload::new(
        "messages",
        stream,
        body,
        &model,
        &route.deployment,
        &headers,
    );

    let upstream = send_upstream(&state, &route, prepared, &mut payload).await?;
    build_messages_response(state, route, upstream, stream, payload).await
}

async fn send_upstream(
    state: &AppState,
    route: &Route,
    prepared: crate::sdk::providers::ProviderRequest,
    payload: &mut StandardLoggingPayload,
) -> Result<reqwest::Response, GatewayError> {
    let upstream = match llm::send_request(
        &state.http,
        route.handler.messages_url(&route.deployment),
        prepared,
    )
    .await
    {
        Ok(upstream) => upstream,
        Err(error) => {
            payload.finish_error(error_information(
                "upstream_request_error",
                error.to_string(),
            ));
            state.callbacks.on_error(payload.clone());
            return Err(error);
        }
    };
    Ok(upstream)
}

async fn build_messages_response(
    state: Arc<AppState>,
    route: Route,
    upstream: reqwest::Response,
    stream: bool,
    payload: StandardLoggingPayload,
) -> Result<Response, GatewayError> {
    let response_headers = route
        .handler
        .transform_messages_response_headers(upstream.headers(), stream);
    if route.handler.transforms_messages_response_body() {
        return llm::build_logged_transformed_response(
            upstream,
            response_headers,
            payload,
            state.callbacks.clone(),
            state.model_cost_map.clone(),
            |body, status, content_type| {
                route.handler.transform_messages_response_body(
                    body,
                    status,
                    stream,
                    &route.deployment,
                    content_type,
                )
            },
        )
        .await;
    }
    llm::build_logged_response(
        upstream,
        response_headers,
        stream,
        payload,
        state.callbacks.clone(),
        state.model_cost_map.clone(),
    )
    .await
}
