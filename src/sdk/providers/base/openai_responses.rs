//! Base contract for providers that target the OpenAI Responses endpoint.

use axum::http::{header, HeaderMap, HeaderValue};
use serde_json::Value;

use crate::{
    errors::GatewayError,
    sdk::{providers::base::ProviderRequest, routing::Deployment},
};

pub trait BaseOpenAiResponsesTransformation: Send + Sync + 'static {
    fn supports_native_file_search(&self) -> bool {
        false
    }

    fn supports_native_websocket(&self) -> bool {
        false
    }

    fn should_fake_stream(&self, _model: Option<&str>, _stream: Option<bool>) -> bool {
        false
    }

    fn map_openai_responses_params(
        &self,
        mut body: Value,
        deployment: &Deployment,
    ) -> Result<Value, GatewayError> {
        if body.get("model").and_then(Value::as_str) != Some(deployment.upstream_model.as_str()) {
            body["model"] = Value::String(deployment.upstream_model.clone());
        }
        Ok(normalize_responses_api_request(body))
    }

    fn validate_environment(
        &self,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<HeaderMap, GatewayError>;

    fn transform_openai_responses_request(
        &self,
        body: Value,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<ProviderRequest, GatewayError> {
        let body = self.map_openai_responses_params(body, deployment)?;
        let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
        let headers = self.validate_environment(deployment, inbound_headers)?;

        Ok(ProviderRequest {
            body: serde_json::to_vec(&body)?,
            headers,
            stream,
        })
    }

    fn transform_openai_responses_response_headers(
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
        if let Some(request_id) = upstream.get("x-request-id").cloned() {
            headers.insert("x-request-id", request_id);
        }
        headers
    }
}

pub fn normalize_responses_api_request(mut body: Value) -> Value {
    let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) else {
        return body;
    };

    for item in input {
        let is_custom_tool_call =
            item.get("type").and_then(Value::as_str) == Some("custom_tool_call");
        if is_custom_tool_call {
            if let Some(object) = item.as_object_mut() {
                object.remove("namespace");
            }
        }
    }
    body
}
