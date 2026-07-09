pub mod transformation;

use crate::sdk::providers::base::ProviderRegistry;
use transformation::OpenAiResponsesTransformation;

const OPENAI_API_BASE: &str = "https://api.openai.com";
const MINIMAX_API_BASE: &str = "https://api.minimax.io/v1";

pub fn init(registry: &mut ProviderRegistry) {
    registry.register("openai", OPENAI_API_BASE, OpenAiResponsesTransformation);
    registry.register("codex", OPENAI_API_BASE, OpenAiResponsesTransformation);
    registry.register("minimax", MINIMAX_API_BASE, OpenAiResponsesTransformation);
}
