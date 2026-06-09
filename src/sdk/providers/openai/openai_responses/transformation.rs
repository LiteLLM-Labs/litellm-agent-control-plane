use axum::http::{header, HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;

use crate::{
    errors::GatewayError,
    sdk::{
        routing::Deployment,
        providers::base::openai_responses::BaseOpenAiResponsesTransformation,
        providers::base::{ProviderRequest, Transformation},
    },
};

// Headers Codex attaches to each turn. Forwarded so upstream logging/analytics
// keep request correlation; harmless to OpenAI if it ignores them.
const FORWARDED_HEADERS: &[&str] = &[
    "accept",
    "originator",
    "session-id",
    "thread-id",
    "x-client-request-id",
    "x-codex-beta-features",
    "x-codex-turn-metadata",
    "x-codex-window-id",
];

#[derive(Debug, Default, Clone)]
pub struct OpenAiResponsesTransformation;

impl BaseOpenAiResponsesTransformation for OpenAiResponsesTransformation {
    fn supports_native_file_search(&self) -> bool {
        true
    }

    fn supports_native_websocket(&self) -> bool {
        true
    }

    fn validate_environment(
        &self,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
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
        for name in FORWARDED_HEADERS {
            if let Some(value) = inbound_headers.get(*name) {
                if let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) {
                    headers.insert(header_name, value.clone());
                }
            }
        }

        Ok(headers)
    }
}

impl Transformation for OpenAiResponsesTransformation {
    fn transform_request(
        &self,
        body: Value,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<ProviderRequest, GatewayError> {
        self.transform_openai_responses_request(body, deployment, inbound_headers)
    }

    fn transform_response_headers(&self, upstream: &HeaderMap, stream: bool) -> HeaderMap {
        self.transform_openai_responses_response_headers(upstream, stream)
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{header, HeaderMap, HeaderValue};
    use serde_json::json;

    use super::OpenAiResponsesTransformation;
    use crate::sdk::{
        providers::base::{
            openai_responses::BaseOpenAiResponsesTransformation, Transformation,
        },
        routing::Deployment,
    };

    fn deployment() -> Deployment {
        Deployment {
            provider_id: "openai".to_owned(),
            upstream_model: "gpt-5.5".to_owned(),
            api_base: "https://api.openai.com".to_owned(),
            api_key: "sk-upstream".to_owned(),
        }
    }

    #[test]
    fn rewrites_model_and_sets_bearer_auth() {
        let req = OpenAiResponsesTransformation
            .transform_request(
                json!({ "model": "gpt-codex", "input": [] }),
                &deployment(),
                &HeaderMap::new(),
            )
            .unwrap();

        let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["model"], "gpt-5.5");
        assert_eq!(
            req.headers.get(header::AUTHORIZATION).unwrap(),
            "Bearer sk-upstream"
        );
        assert!(!req.stream);
    }

    #[test]
    fn detects_stream_flag() {
        let req = OpenAiResponsesTransformation
            .transform_request(
                json!({ "model": "gpt-5.5", "stream": true }),
                &deployment(),
                &HeaderMap::new(),
            )
            .unwrap();
        assert!(req.stream);
    }

    #[test]
    fn forwards_codex_headers() {
        let mut inbound = HeaderMap::new();
        inbound.insert("originator", HeaderValue::from_static("codex_exec"));
        inbound.insert("session-id", HeaderValue::from_static("abc"));

        let req = OpenAiResponsesTransformation
            .transform_request(json!({ "model": "gpt-5.5" }), &deployment(), &inbound)
            .unwrap();

        assert_eq!(req.headers.get("originator").unwrap(), "codex_exec");
        assert_eq!(req.headers.get("session-id").unwrap(), "abc");
    }

    #[test]
    fn streaming_response_is_event_stream() {
        let headers =
            OpenAiResponsesTransformation.transform_response_headers(&HeaderMap::new(), true);
        assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "text/event-stream");
    }

    #[test]
    fn strips_custom_tool_namespace_in_base_responses_transform() {
        let req = OpenAiResponsesTransformation
            .transform_request(
                json!({
                    "model": "gpt-5.5",
                    "input": [
                        {
                            "type": "custom_tool_call",
                            "name": "tool",
                            "namespace": "internal"
                        }
                    ]
                }),
                &deployment(),
                &HeaderMap::new(),
            )
            .unwrap();

        let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert!(body["input"][0].get("namespace").is_none());
    }

    #[test]
    fn declares_native_responses_capabilities() {
        assert!(OpenAiResponsesTransformation.supports_native_file_search());
        assert!(OpenAiResponsesTransformation.supports_native_websocket());
    }
}
