mod auth;
mod config;
mod events;
mod reply;
mod reply_events;
mod reply_lock;
mod reply_stream;
pub mod repository;
pub mod schema;
mod session_lock;
mod storage;
mod types;
mod web_api;

use std::sync::Arc;

use axum::{routing::post, Router};

use crate::proxy::state::AppState;

pub(crate) use events::messages;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/agents/{agent_id}/teams/messages", post(messages))
}
