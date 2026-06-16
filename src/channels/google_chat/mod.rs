mod auth;
mod config;
mod event_message;
mod events;
mod locks;
mod reply;
mod reply_stream;
pub mod repository;
mod types;
mod web_api;

use std::sync::Arc;

use axum::{routing::post, Router};

use crate::proxy::state::AppState;

pub(crate) use events::events;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/agents/{agent_id}/google-chat/events", post(events))
}
