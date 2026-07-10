pub mod transformation;

use crate::sdk::providers::base::ProviderRegistry;
use transformation::MiniMaxTransformation;

pub const GLOBAL_BASE_URL: &str = "https://api.minimax.io/anthropic/v1";
pub const CN_BASE_URL: &str = "https://api.minimaxi.com/anthropic/v1";

pub fn init(registry: &mut ProviderRegistry) {
    registry.register("minimax", GLOBAL_BASE_URL, MiniMaxTransformation);
}
