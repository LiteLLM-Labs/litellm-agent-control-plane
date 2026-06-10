pub mod anthropic_messages;
pub(crate) mod list_model;
pub mod runtime;

use crate::sdk::{
    agents::AgentRuntime,
    providers::base::{models::ModelEndpointRegistry, runtime::RuntimeAdapterRegistry},
};

pub use anthropic_messages::{init, transformation};

pub(crate) fn register_runtime_adapters(registry: &mut RuntimeAdapterRegistry) {
    registry.register(
        AgentRuntime::ClaudeManagedAgents,
        runtime::RUNTIME_ID,
        runtime::ClaudeManagedAgentsRuntime,
    );
}

pub(crate) fn register_model_endpoints(registry: &mut ModelEndpointRegistry) {
    registry.register(
        AgentRuntime::ClaudeManagedAgents,
        runtime::RUNTIME_ID,
        list_model::AnthropicModels,
    );
}
