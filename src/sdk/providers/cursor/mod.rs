pub mod runtime;

use crate::sdk::{agents::AgentRuntime, providers::base::runtime::RuntimeAdapterRegistry};

pub(crate) fn register_runtime_adapters(registry: &mut RuntimeAdapterRegistry) {
    registry.register(
        AgentRuntime::Cursor,
        runtime::RUNTIME_ID,
        runtime::CursorRuntime,
    );
}
