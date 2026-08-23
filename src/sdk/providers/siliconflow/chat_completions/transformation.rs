//! SiliconFlow (硅基流动) Chat Completions transformation.
//!
//! SiliconFlow exposes an OpenAI-compatible Chat Completions API at
//! `{api_base}/v1/chat/completions`. opencode's built-in "openai" provider
//! sends Chat Completions-shaped requests, so this adapter is a thin passthrough:
//! it rewrites the model to the configured upstream model, injects the Bearer
//! auth header, and forwards the body unchanged to the upstream endpoint.

use axum::http::{header, HeaderMap, HeaderValue};
use serde_json::Value;

use crate::{
    errors::GatewayError,
    sdk::{
        providers::base::{ProviderRequest, Transformation},
        routing::Deployment,
    },
};

#[derive(Debug, Default, Clone)]
pub struct SiliconFlowTransformation;

impl SiliconFlowTransformation {
    fn validate_environment(
        &self,
        deployment: &Deployment,
        _inbound_headers: &HeaderMap,
    ) -> Result<HeaderMap, GatewayError> {
        let mut headers = HeaderMap::new();
        let bearer = format!("Bearer {}", deployment.api_key);
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&bearer)
                .map_err(|_| GatewayError::InvalidConfig("invalid api_key".to_owned()))?,
        );
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        Ok(headers)
    }

    fn map_params(&self, mut body: Value, deployment: &Deployment) -> Value {
        if body.get("model").and_then(Value::as_str) != Some(deployment.upstream_model.as_str()) {
            body["model"] = Value::String(deployment.upstream_model.clone());
        }
        body
    }
}

impl Transformation for SiliconFlowTransformation {
    fn transform_request(
        &self,
        body: Value,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<ProviderRequest, GatewayError> {
        let body = self.map_params(body, deployment);
        let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
        let headers = self.validate_environment(deployment, inbound_headers)?;
        Ok(ProviderRequest {
            body: serde_json::to_vec(&body)?,
            headers,
            stream,
        })
    }

    fn transform_response_headers(&self, upstream: &HeaderMap, stream: bool) -> HeaderMap {
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

#[cfg(test)]
mod tests {
    use axum::http::{header, HeaderMap};
    use serde_json::json;

    use super::SiliconFlowTransformation;
    use crate::sdk::{providers::base::Transformation, routing::Deployment};

    fn deployment() -> Deployment {
        Deployment {
            provider_id: "siliconflow".to_owned(),
            upstream_model: "deepseek-ai/DeepSeek-V4-Flash".to_owned(),
            api_base: "https://api.siliconflow.cn".to_owned(),
            api_key: "sk-upstream".to_owned(),
        }
    }

    #[test]
    fn rewrites_model_and_sets_bearer_auth() {
        let req = SiliconFlowTransformation
            .transform_request(
                json!({ "model": "deepseek-ai/DeepSeek-V4-Flash", "messages": [] }),
                &deployment(),
                &HeaderMap::new(),
            )
            .unwrap();

        let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["model"], "deepseek-ai/DeepSeek-V4-Flash");
        assert_eq!(
            req.headers.get(header::AUTHORIZATION).unwrap(),
            "Bearer sk-upstream"
        );
        assert!(!req.stream);
    }

    #[test]
    fn detects_stream_flag() {
        let req = SiliconFlowTransformation
            .transform_request(
                json!({ "model": "deepseek-ai/DeepSeek-V4-Flash", "stream": true }),
                &deployment(),
                &HeaderMap::new(),
            )
            .unwrap();
        assert!(req.stream);
    }

    #[test]
    fn streaming_response_is_event_stream() {
        let headers =
            SiliconFlowTransformation.transform_response_headers(&HeaderMap::new(), true);
        assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "text/event-stream");
    }
}
