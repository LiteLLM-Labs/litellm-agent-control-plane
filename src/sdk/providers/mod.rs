//! Provider-owned SDK integrations.
//!
//! Each provider folder owns the target endpoints and runtimes it supports.

use std::sync::Arc;

use crate::sdk::{
    agents::AgentRuntime,
    providers::base::{models::ModelEndpoint, runtime::RuntimeAdapter},
};

pub use crate::sdk::providers::base::{
    Provider, ProviderRegistry, ProviderRequest, Transformation,
};

pub mod base;

pub(crate) fn adapter(runtime: AgentRuntime) -> Option<Arc<dyn RuntimeAdapter>> {
    runtime_registry().get(runtime)
}

pub(crate) fn runtime_registry() -> base::runtime::RuntimeAdapterRegistry {
    let mut registry = base::runtime::RuntimeAdapterRegistry::new();
    register_runtime_adapters(&mut registry);
    registry
}

pub(crate) fn model_endpoint(runtime: AgentRuntime) -> Option<Arc<dyn ModelEndpoint>> {
    model_registry().get(runtime)
}

pub(crate) fn model_registry() -> base::models::ModelEndpointRegistry {
    let mut registry = base::models::ModelEndpointRegistry::new();
    register_model_endpoints(&mut registry);
    registry
}

pub mod model {
    pub use crate::sdk::providers::base::{
        Provider, ProviderRegistry, ProviderRequest, Transformation,
    };
}

pub mod transform {
    pub use crate::sdk::providers::base::{
        Provider, ProviderRegistry, ProviderRequest, Transformation,
    };
}

include!(concat!(env!("OUT_DIR"), "/providers_generated.rs"));
