use std::sync::Arc;

use axum::Router;

use crate::proxy::state::AppState;

pub mod google_chat;
pub mod slack;
pub mod teams;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .merge(google_chat::router())
        .merge(slack::router())
        .merge(teams::router())
}
