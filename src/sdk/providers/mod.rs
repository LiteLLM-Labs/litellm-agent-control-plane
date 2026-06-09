//! Provider-owned SDK integrations.
//!
//! Each provider folder owns the target endpoints and runtimes it supports.

use std::sync::Arc;

use crate::sdk::{agents::AgentRuntime, providers::base::runtime::RuntimeAdapter};

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
