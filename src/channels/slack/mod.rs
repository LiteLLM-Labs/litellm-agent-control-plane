pub mod bindings;
pub(crate) mod config;
mod dispatch;
pub(crate) mod dm_api;
mod events;
mod factory_access;
mod form;
mod interactivity;
pub(crate) mod manifest_api;
mod message;
mod oauth;
mod replies;
mod reply_chunks;
mod reply_format;
mod reply_lock;
mod reply_storage;
mod reply_stream;
pub mod repository;
pub mod schema;
mod signature;
pub(crate) mod types;
pub(crate) mod user_ids;
pub(crate) mod web_api;

use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};

use crate::proxy::state::AppState;

pub use events::events;
pub use interactivity::interactivity;
pub use oauth::{oauth_callback, oauth_state};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/agents/{agent_id}/slack/events", post(events))
        .route(
            "/api/agents/{agent_id}/slack/interactivity",
            post(interactivity),
        )
        .route(
            "/api/agents/{agent_id}/slack/oauth-state",
            post(oauth_state),
        )
        .route("/host-oauth-callback/{provider_id}", get(oauth_callback))
}
