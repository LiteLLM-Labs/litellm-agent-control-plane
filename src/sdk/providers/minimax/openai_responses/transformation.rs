use axum::http::{header, HeaderMap, HeaderValue};
use serde_json::Value;

use crate::{
    errors::GatewayError,
    sdk::{
        providers::{
            base::{
                openai_responses::BaseOpenAiResponsesTransformation, ProviderRequest,
                Transformation,
            },
            minimax::anthropic_messages::transformation::{
                self as anthropic_messages, MiniMaxTransformation,
            },
        },
        routing::Deployment,
    },
};

impl BaseOpenAiResponsesTransformation for MiniMaxTransformation {
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
}

impl Transformation for MiniMaxTransformation {
    fn catalog_models(
        &self,
        models: Vec<String>,
        cost_map: &crate::model_prices::ModelCostMap,
    ) -> Vec<String> {
        let mut current = vec![
            "minimax/MiniMax-M3.1-Flash".to_owned(),
            "minimax/MiniMax-M3".to_owned(),
        ];
        current.extend(models.into_iter().filter(|model| {
            cost_map
                .get(model)
                .and_then(|info| info.mode.as_deref())
                .is_some_and(|mode| mode != "chat")
        }));
        current
    }

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

    fn responses_url(&self, deployment: &Deployment) -> String {
        super::super::openai_responses_url(&deployment.api_base)
    }

    fn messages_url(&self, deployment: &Deployment) -> String {
        anthropic_messages::messages_url(deployment)
    }

    fn transform_messages_request(
        &self,
        body: Value,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<ProviderRequest, GatewayError> {
        anthropic_messages::transform_request(self, body, deployment, inbound_headers)
    }

    fn transform_messages_response_headers(&self, upstream: &HeaderMap, stream: bool) -> HeaderMap {
        anthropic_messages::transform_response_headers(self, upstream, stream)
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{header, HeaderMap};
    use serde_json::json;

    use super::MiniMaxTransformation;
    use crate::sdk::{
        providers::{
            base::Transformation,
            minimax::{
                CN_ANTHROPIC_BASE_URL, CN_OPENAI_BASE_URL, GLOBAL_ANTHROPIC_BASE_URL,
                GLOBAL_OPENAI_BASE_URL,
            },
        },
        routing::Deployment,
    };

    fn deployment(api_base: &str) -> Deployment {
        Deployment {
            provider_id: "minimax".to_owned(),
            upstream_model: "MiniMax-M2.7".to_owned(),
            api_base: api_base.to_owned(),
            api_key: "test-key".to_owned(),
        }
    }

    #[test]
    fn targets_responses_endpoint_for_each_supported_base() {
        for (api_base, expected) in [
            (
                GLOBAL_ANTHROPIC_BASE_URL,
                "https://api.minimax.io/v1/responses",
            ),
            (
                GLOBAL_OPENAI_BASE_URL,
                "https://api.minimax.io/v1/responses",
            ),
            (
                CN_ANTHROPIC_BASE_URL,
                "https://api.minimaxi.com/v1/responses",
            ),
            (
                CN_OPENAI_BASE_URL,
                "https://api.minimaxi.com/v1/responses",
            ),
        ] {
            assert_eq!(
                MiniMaxTransformation.responses_url(&deployment(api_base)),
                expected
            );
        }
    }

    #[test]
    fn rewrites_model_and_sets_openai_headers() {
        let request = MiniMaxTransformation
            .transform_request(
                json!({
                    "model": "MiniMax-M3",
                    "input": "hello",
                    "stream": true
                }),
                &deployment(GLOBAL_OPENAI_BASE_URL),
                &HeaderMap::new(),
            )
            .unwrap();

        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["model"], "MiniMax-M2.7");
        assert_eq!(
            request.headers.get(header::AUTHORIZATION).unwrap(),
            "Bearer test-key"
        );
        assert!(request.stream);
    }
}
