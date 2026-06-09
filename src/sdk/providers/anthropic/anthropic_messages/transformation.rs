use axum::http::{HeaderMap, HeaderValue};
use serde_json::Value;

use crate::{
    errors::GatewayError,
    sdk::{
        routing::Deployment,
        providers::base::anthropic_messages::BaseAnthropicMessagesTransformation,
        providers::base::{ProviderRequest, Transformation},
    },
};

const DEFAULT_ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Default, Clone)]
pub struct AnthropicTransformation;

impl BaseAnthropicMessagesTransformation for AnthropicTransformation {
    fn validate_environment(
        &self,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<HeaderMap, GatewayError> {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-api-key",
            HeaderValue::from_str(&deployment.api_key)
                .map_err(|_| GatewayError::InvalidConfig("invalid api_key".to_owned()))?,
        );
        headers.insert(
            "anthropic-version",
            inbound_headers
                .get("anthropic-version")
                .cloned()
                .unwrap_or_else(|| HeaderValue::from_static(DEFAULT_ANTHROPIC_VERSION)),
        );
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        if let Some(beta) = inbound_headers.get("anthropic-beta") {
            headers.insert("anthropic-beta", beta.clone());
        }

        Ok(headers)
    }
}

impl Transformation for AnthropicTransformation {
    fn transform_request(
        &self,
        body: Value,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<ProviderRequest, GatewayError> {
        self.transform_anthropic_messages_request(body, deployment, inbound_headers)
    }

    fn transform_response_headers(&self, upstream: &HeaderMap, stream: bool) -> HeaderMap {
        self.transform_anthropic_messages_response_headers(upstream, stream)
    }
}
