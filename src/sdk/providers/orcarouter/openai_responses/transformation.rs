use axum::http::{header, HeaderMap, HeaderValue};
use serde_json::Value;

use crate::{
    errors::GatewayError,
    sdk::{
        providers::base::openai_responses::BaseOpenAiResponsesTransformation,
        providers::base::{ProviderRequest, Transformation},
        routing::Deployment,
    },
};

#[derive(Debug, Default, Clone)]
pub struct OrcaRouterResponsesTransformation;

impl BaseOpenAiResponsesTransformation for OrcaRouterResponsesTransformation {
    fn validate_environment(
        &self,
        deployment: &Deployment,
        _inbound_headers: &HeaderMap,
    ) -> Result<HeaderMap, GatewayError> {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", deployment.api_key))
                .map_err(|_| GatewayError::InvalidConfig("invalid api_key".to_owned()))?,
        );
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        Ok(headers)
    }
}

impl Transformation for OrcaRouterResponsesTransformation {
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
    use axum::http::{header, HeaderMap};
    use serde_json::json;

    use super::OrcaRouterResponsesTransformation;
    use crate::sdk::{
        providers::base::Transformation,
        routing::Deployment,
    };

    fn deployment() -> Deployment {
        Deployment {
            provider_id: "orcarouter".to_owned(),
            upstream_model: "openai/gpt-5.5".to_owned(),
            api_base: "https://api.orcarouter.ai".to_owned(),
            api_key: "sk-orca-test".to_owned(),
        }
    }

    #[test]
    fn rewrites_model_and_sets_bearer_auth() {
        let req = OrcaRouterResponsesTransformation
            .transform_request(
                json!({ "model": "gpt-codex", "input": [] }),
                &deployment(),
                &HeaderMap::new(),
            )
            .unwrap();

        let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["model"], "openai/gpt-5.5");
        assert_eq!(
            req.headers.get(header::AUTHORIZATION).unwrap(),
            "Bearer sk-orca-test"
        );
        assert!(!req.stream);
    }

    #[test]
    fn detects_stream_flag() {
        let req = OrcaRouterResponsesTransformation
            .transform_request(
                json!({ "model": "openai/gpt-5.5", "stream": true }),
                &deployment(),
                &HeaderMap::new(),
            )
            .unwrap();
        assert!(req.stream);
    }

    #[test]
    fn streaming_response_is_event_stream() {
        let headers = OrcaRouterResponsesTransformation
            .transform_response_headers(&HeaderMap::new(), true);
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );
    }
}
