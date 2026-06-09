use std::{collections::HashMap, sync::Arc};

use crate::{
    errors::GatewayError,
    proxy::config::GatewayConfig,
    sdk::providers::{ProviderRegistry, Transformation},
};

#[derive(Debug, Clone)]
pub struct Deployment {
    pub provider_id: String,
    pub upstream_model: String,
    pub api_base: String,
    pub api_key: String,
}

impl Deployment {
    pub fn messages_url(&self) -> String {
        format!("{}/v1/messages", self.api_base.trim_end_matches('/'))
    }

    pub fn responses_url(&self) -> String {
        format!("{}/v1/responses", self.api_base.trim_end_matches('/'))
    }
}

#[derive(Clone)]
pub struct Route {
    pub deployment: Deployment,
    pub handler: Arc<dyn Transformation>,
}

pub struct Router {
    routes: HashMap<String, Route>,
    wildcard: Option<Route>,
}

impl Router {
    pub fn from_config(
        config: &GatewayConfig,
        providers: &ProviderRegistry,
    ) -> Result<Self, GatewayError> {
        let mut routes = HashMap::with_capacity(config.model_list.len());
        let mut wildcard = None;

        for entry in &config.model_list {
            let model = &entry.litellm_params.model;
            let Some((provider_id, upstream_model)) = model.split_once('/') else {
                return Err(GatewayError::InvalidConfig(format!(
                    "model must include provider prefix (e.g. anthropic/...), got {model}"
                )));
            };
            if upstream_model.trim().is_empty() {
                return Err(GatewayError::InvalidConfig(format!(
                    "model missing name after provider prefix, got {model}"
                )));
            }

            let provider = providers.get(provider_id).ok_or_else(|| {
                GatewayError::InvalidConfig(format!("unsupported provider: {provider_id}"))
            })?;

            let route = Route {
                deployment: Deployment {
                    provider_id: provider_id.to_owned(),
                    upstream_model: upstream_model.to_owned(),
                    api_base: entry
                        .litellm_params
                        .api_base
                        .clone()
                        .unwrap_or_else(|| provider.default_api_base.clone()),
                    api_key: entry.litellm_params.api_key.clone().unwrap_or_default(),
                },
                handler: provider.handler,
            };

            if entry.model_name.ends_with("/*") && upstream_model == "*" {
                if wildcard.is_some() {
                    return Err(GatewayError::InvalidConfig(
                        "only one wildcard model route is supported".to_owned(),
                    ));
                }
                wildcard = Some(route);
            } else {
                routes.insert(entry.model_name.clone(), route);
            }
        }

        Ok(Self { routes, wildcard })
    }

    pub fn resolve(&self, model: &str) -> Result<Route, GatewayError> {
        if let Some(route) = self.routes.get(model) {
            tracing::debug!(
                model,
                upstream_model = %route.deployment.upstream_model,
                provider = %route.deployment.provider_id,
                "router: exact match"
            );
            return Ok(route.clone());
        }

        let Some(route) = &self.wildcard else {
            tracing::debug!(model, "router: no exact match and no wildcard route");
            return Err(GatewayError::UnknownModel(model.to_owned()));
        };
        let mut route = route.clone();
        let upstream = passthrough_model(model, &route.deployment.provider_id);
        tracing::debug!(
            model,
            upstream_model = %upstream,
            provider = %route.deployment.provider_id,
            "router: wildcard match — stripped provider prefix"
        );
        route.deployment.upstream_model = upstream;
        Ok(route)
    }
}

fn passthrough_model(model: &str, provider_id: &str) -> String {
    model
        .strip_prefix(&format!("{provider_id}/"))
        .unwrap_or(model)
        .to_owned()
}

impl std::fmt::Debug for Router {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Router")
            .field("models", &self.routes.keys().collect::<Vec<_>>())
            .field("wildcard", &self.wildcard.is_some())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::Router;
    use crate::proxy::config::{GatewayConfig, LiteLlmParams, ModelEntry};
    use crate::sdk::providers::{self, ProviderRegistry};

    #[test]
    fn resolves_model_to_upstream() {
        let mut providers = ProviderRegistry::new();
        providers::register_all(&mut providers);

        let config = GatewayConfig {
            model_list: vec![ModelEntry {
                model_name: "claude".to_owned(),
                litellm_params: LiteLlmParams {
                    model: "anthropic/claude-sonnet-4-5".to_owned(),
                    api_key: Some("sk".to_owned()),
                    api_base: None,
                    extra: Default::default(),
                },
            }],
            mcp_servers: Default::default(),
            general_settings: Default::default(),
            slack: Default::default(),
            agents: Vec::new(),
        };

        let router = Router::from_config(&config, &providers).unwrap();
        let route = router.resolve("claude").unwrap();
        assert_eq!(route.deployment.upstream_model, "claude-sonnet-4-5");
        assert_eq!(route.deployment.provider_id, "anthropic");
    }

    #[test]
    fn resolves_wildcard_model_to_anthropic_passthrough() {
        let mut providers = ProviderRegistry::new();
        providers::register_all(&mut providers);

        let config = GatewayConfig {
            model_list: vec![ModelEntry {
                model_name: "anthropic/*".to_owned(),
                litellm_params: LiteLlmParams {
                    model: "anthropic/*".to_owned(),
                    api_key: Some("sk".to_owned()),
                    api_base: None,
                    extra: Default::default(),
                },
            }],
            mcp_servers: Default::default(),
            general_settings: Default::default(),
            slack: Default::default(),
            agents: Vec::new(),
        };

        let router = Router::from_config(&config, &providers).unwrap();
        let route = router.resolve("claude-opus-4-8").unwrap();
        assert_eq!(route.deployment.provider_id, "anthropic");
        assert_eq!(route.deployment.upstream_model, "claude-opus-4-8");
    }

    #[test]
    fn strips_provider_prefix_from_wildcard_model() {
        let mut providers = ProviderRegistry::new();
        providers::register_all(&mut providers);

        let config = GatewayConfig {
            model_list: vec![ModelEntry {
                model_name: "anthropic/*".to_owned(),
                litellm_params: LiteLlmParams {
                    model: "anthropic/*".to_owned(),
                    api_key: Some("sk".to_owned()),
                    api_base: None,
                    extra: Default::default(),
                },
            }],
            mcp_servers: Default::default(),
            general_settings: Default::default(),
            slack: Default::default(),
            agents: Vec::new(),
        };

        let router = Router::from_config(&config, &providers).unwrap();
        let route = router.resolve("anthropic/claude-opus-4-8").unwrap();
        assert_eq!(route.deployment.upstream_model, "claude-opus-4-8");
    }

    #[test]
    fn exact_route_takes_precedence_over_wildcard() {
        let mut providers = ProviderRegistry::new();
        providers::register_all(&mut providers);

        let config = GatewayConfig {
            model_list: vec![
                ModelEntry {
                    model_name: "claude".to_owned(),
                    litellm_params: LiteLlmParams {
                        model: "anthropic/claude-sonnet-4-5".to_owned(),
                        api_key: Some("sk".to_owned()),
                        api_base: None,
                        extra: Default::default(),
                    },
                },
                ModelEntry {
                    model_name: "anthropic/*".to_owned(),
                    litellm_params: LiteLlmParams {
                        model: "anthropic/*".to_owned(),
                        api_key: Some("sk".to_owned()),
                        api_base: None,
                        extra: Default::default(),
                    },
                },
            ],
            mcp_servers: Default::default(),
            general_settings: Default::default(),
            slack: Default::default(),
            agents: Vec::new(),
        };

        let router = Router::from_config(&config, &providers).unwrap();
        let route = router.resolve("claude").unwrap();
        assert_eq!(route.deployment.upstream_model, "claude-sonnet-4-5");
    }
}
