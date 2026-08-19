pub mod transformation;

use crate::sdk::providers::base::ProviderRegistry;
use transformation::OrcaRouterResponsesTransformation;

const ORCAROUTER_API_BASE: &str = "https://api.orcarouter.ai";

pub fn init(registry: &mut ProviderRegistry) {
    registry.register(
        "orcarouter",
        ORCAROUTER_API_BASE,
        OrcaRouterResponsesTransformation,
    );
}
