pub mod transformation;

use crate::sdk::providers::base::ProviderRegistry;
use transformation::SiliconFlowTransformation;

const SILICONFLOW_API_BASE: &str = "https://api.siliconflow.cn";

pub fn init(registry: &mut ProviderRegistry) {
    registry.register("siliconflow", SILICONFLOW_API_BASE, SiliconFlowTransformation);
}
