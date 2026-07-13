pub mod transformation;

use crate::sdk::providers::base::ProviderRegistry;
use transformation::MiniMaxTransformation;

pub use super::{
    CN_ANTHROPIC_BASE_URL as CN_BASE_URL, GLOBAL_ANTHROPIC_BASE_URL as GLOBAL_BASE_URL,
};

pub fn init(registry: &mut ProviderRegistry) {
    registry.register("minimax", GLOBAL_BASE_URL, MiniMaxTransformation);
}
