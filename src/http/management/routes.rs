use std::sync::Arc;

use axum::{
    routing::{delete, get},
    Router,
};

use crate::proxy::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/keys",
            get(super::api_keys::list).post(super::api_keys::create),
        )
        .route("/api/keys/{id}", delete(super::api_keys::delete))
}
