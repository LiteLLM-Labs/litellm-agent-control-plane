//! Base contract for providers that target the Anthropic Messages endpoint.

use axum::http::{header, HeaderMap, HeaderValue};
use serde_json::Value;

use crate::{
    errors::GatewayError,
    sdk::{providers::base::ProviderRequest, routing::Deployment},
};

pub trait BaseAnthropicMessagesTransformation: Send + Sync + 'static {
    fn map_anthropic_messages_params(
        &self,
        mut body: Value,
        deployment: &Deployment,
    ) -> Result<Value, GatewayError> {
        if body.get("model").and_then(Value::as_str) != Some(deployment.upstream_model.as_str()) {
            body["model"] = Value::String(deployment.upstream_model.clone());
        }
        Ok(body)
    }

    fn validate_environment(
        &self,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<HeaderMap, GatewayError>;

    fn transform_anthropic_messages_request(
        &self,
        body: Value,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<ProviderRequest, GatewayError> {
        let body = self.map_anthropic_messages_params(body, deployment)?;
        let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
        let headers = self.validate_environment(deployment, inbound_headers)?;

        Ok(ProviderRequest {
            body: serde_json::to_vec(&body)?,
            headers,
            stream,
        })
    }

    fn transform_anthropic_messages_response_headers(
        &self,
        upstream: &HeaderMap,
        stream: bool,
    ) -> HeaderMap {
        let mut headers = HeaderMap::new();
        let content_type = if stream {
            HeaderValue::from_static("text/event-stream")
        } else {
            upstream
                .get(header::CONTENT_TYPE)
                .cloned()
                .unwrap_or_else(|| HeaderValue::from_static("application/json"))
        };
        headers.insert(header::CONTENT_TYPE, content_type);
        if let Some(request_id) = upstream.get("request-id").cloned() {
            headers.insert("request-id", request_id);
        }
        headers
    }
}
