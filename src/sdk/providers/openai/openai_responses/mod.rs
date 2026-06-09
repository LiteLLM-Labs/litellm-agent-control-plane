pub mod transformation;

use crate::sdk::providers::base::ProviderRegistry;
use transformation::OpenAiResponsesTransformation;

const OPENAI_API_BASE: &str = "https://api.openai.com";

pub fn init(registry: &mut ProviderRegistry) {
    registry.register("openai", OPENAI_API_BASE, OpenAiResponsesTransformation);
    registry.register("codex", OPENAI_API_BASE, OpenAiResponsesTransformation);
}
