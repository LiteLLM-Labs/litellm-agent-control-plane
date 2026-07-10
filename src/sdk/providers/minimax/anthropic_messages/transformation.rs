use axum::http::{HeaderMap, HeaderValue};
use serde_json::Value;

use crate::{
    errors::GatewayError,
    sdk::{
        providers::base::{
            anthropic_messages::BaseAnthropicMessagesTransformation, ProviderRequest,
            Transformation,
        },
        routing::Deployment,
    },
};

const DEFAULT_ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Default, Clone)]
pub struct MiniMaxTransformation;

impl BaseAnthropicMessagesTransformation for MiniMaxTransformation {
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

impl Transformation for MiniMaxTransformation {
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

    fn messages_url(&self, deployment: &Deployment) -> String {
        format!("{}/messages", deployment.api_base.trim_end_matches('/'))
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};
    use serde_json::json;

    use super::MiniMaxTransformation;
    use crate::sdk::{
        providers::{
            base::{anthropic_messages::BaseAnthropicMessagesTransformation, Transformation},
            minimax::anthropic_messages::{CN_BASE_URL, GLOBAL_BASE_URL},
        },
        routing::Deployment,
    };

    fn deployment(api_base: &str) -> Deployment {
        Deployment {
            provider_id: "minimax".to_owned(),
            upstream_model: "MiniMax-M3".to_owned(),
            api_base: api_base.to_owned(),
            api_key: "test-key".to_owned(),
        }
    }

    #[test]
    fn targets_global_and_cn_messages_endpoints() {
        assert_eq!(
            MiniMaxTransformation.messages_url(&deployment(GLOBAL_BASE_URL)),
            "https://api.minimax.io/anthropic/v1/messages"
        );
        assert_eq!(
            MiniMaxTransformation.messages_url(&deployment(CN_BASE_URL)),
            "https://api.minimaxi.com/anthropic/v1/messages"
        );
    }

    #[test]
    fn rewrites_model_and_sets_anthropic_headers() {
        let mut inbound = HeaderMap::new();
        inbound.insert("anthropic-beta", HeaderValue::from_static("test-feature"));
        let request = MiniMaxTransformation
            .transform_anthropic_messages_request(
                json!({
                    "model": "MiniMax-M2.7",
                    "max_tokens": 64,
                    "messages": [{"role": "user", "content": "hello"}]
                }),
                &deployment(GLOBAL_BASE_URL),
                &inbound,
            )
            .unwrap();

        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["model"], "MiniMax-M3");
        assert_eq!(request.headers.get("x-api-key").unwrap(), "test-key");
        assert_eq!(
            request.headers.get("anthropic-version").unwrap(),
            "2023-06-01"
        );
        assert_eq!(
            request.headers.get("anthropic-beta").unwrap(),
            "test-feature"
        );
    }
}
