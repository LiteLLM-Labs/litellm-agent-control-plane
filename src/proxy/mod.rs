//! Proxy-server concerns: config, request auth, shared state. SDK routing and
//! translation must not depend on anything here.

pub mod auth;
pub mod config;
mod config_types;
pub mod credential_crypto;
mod mcp_config;
pub mod provider_credentials;
pub mod state;
pub mod vault;
