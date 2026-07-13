pub mod anthropic_messages;
mod openai_responses;

pub use anthropic_messages::{init, transformation};

pub const GLOBAL_ANTHROPIC_BASE_URL: &str = "https://api.minimax.io/anthropic";
pub const GLOBAL_OPENAI_BASE_URL: &str = "https://api.minimax.io/v1";
pub const CN_ANTHROPIC_BASE_URL: &str = "https://api.minimaxi.com/anthropic";
pub const CN_OPENAI_BASE_URL: &str = "https://api.minimaxi.com/v1";

pub(crate) fn anthropic_messages_url(api_base: &str) -> String {
    format!("{}/anthropic/v1/messages", api_root(api_base))
}

pub(crate) fn openai_responses_url(api_base: &str) -> String {
    format!("{}/v1/responses", api_root(api_base))
}

fn api_root(api_base: &str) -> &str {
    let api_base = api_base.trim_end_matches('/');
    api_base
        .strip_suffix("/anthropic")
        .or_else(|| api_base.strip_suffix("/v1"))
        .unwrap_or(api_base)
}
