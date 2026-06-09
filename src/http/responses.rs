use std::sync::Arc;

use axum::{body::Bytes, extract::State, http::HeaderMap, response::Response};
use serde_json::Value;

use crate::{
    callbacks::standard_logging::{error_information, StandardLoggingPayload},
    errors::GatewayError,
    http::{credential_overrides, llm},
    proxy::{auth::master_key::require_master_key, state::AppState},
};

pub async fn responses(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, GatewayError> {
    require_master_key(
        &headers,
        state.config.general_settings.master_key.as_deref(),
    )?;

    let body: Value = serde_json::from_slice(&body).map_err(GatewayError::InvalidJson)?;
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or(GatewayError::MissingModel)?
        .to_owned();
    let route = credential_overrides::apply(&state, state.router.resolve(&model)?).await?;

    let prepared = route
        .handler
        .transform_request(body.clone(), &route.deployment, &headers)?;
    let stream = prepared.stream;
    let mut payload = StandardLoggingPayload::new(
        "responses",
        stream,
        body,
        &model,
        &route.deployment,
        &headers,
    );

    let upstream =
        match llm::send_request(&state.http, route.deployment.responses_url(), prepared).await {
            Ok(upstream) => upstream,
            Err(error) => {
                payload.finish_error(error_information(
                    "upstream_request_error",
                    error.to_string(),
                ));
                state.callbacks.on_error(payload);
                return Err(error);
            }
        };
    let response_headers = route
        .handler
        .transform_response_headers(upstream.headers(), stream);
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
