pub mod anthropic_messages;
pub mod runtime;

use crate::sdk::{agents::AgentRuntime, providers::base::runtime::RuntimeAdapterRegistry};

pub use anthropic_messages::{init, transformation};

pub(crate) fn register_runtime_adapters(registry: &mut RuntimeAdapterRegistry) {
    registry.register(
        AgentRuntime::ClaudeManagedAgents,
        runtime::RUNTIME_ID,
        runtime::ClaudeManagedAgentsRuntime,
    );
}
