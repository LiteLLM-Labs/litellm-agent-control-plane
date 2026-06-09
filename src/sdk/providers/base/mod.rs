//! Base contract for provider endpoint transformations.
//!
//! Implement this once per provider endpoint, such as Anthropic Messages or
//! OpenAI Responses. Routing selects the implementation; HTTP owns networking.

pub mod anthropic_messages;
pub mod openai_responses;
pub(crate) mod runtime;

use std::{collections::HashMap, sync::Arc};

use axum::http::HeaderMap;
use serde_json::Value;

use crate::{errors::GatewayError, sdk::routing::Deployment};

pub struct ProviderRequest {
    pub body: Vec<u8>,
    pub headers: HeaderMap,
    pub stream: bool,
}

pub trait Transformation: Send + Sync + 'static {
    fn transform_request(
        &self,
        body: Value,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<ProviderRequest, GatewayError>;

    fn transform_response_headers(&self, upstream: &HeaderMap, stream: bool) -> HeaderMap;
}

#[derive(Clone)]
pub struct Provider {
    pub handler: Arc<dyn Transformation>,
    pub default_api_base: String,
}

#[derive(Default)]
pub struct ProviderRegistry {
    providers: HashMap<String, Provider>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &mut self,
        id: &'static str,
        default_api_base: &'static str,
        handler: impl Transformation,
    ) {
        self.providers.insert(
            id.to_owned(),
            Provider {
                handler: Arc::new(handler),
                default_api_base: default_api_base.to_owned(),
            },
        );
    }

    pub fn get(&self, id: &str) -> Option<Provider> {
        self.providers.get(id).cloned()
    }
}

impl std::fmt::Debug for ProviderRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderRegistry")
            .field("providers", &self.providers.keys().collect::<Vec<_>>())
            .finish()
    }
}
