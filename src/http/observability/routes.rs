use std::sync::Arc;

use axum::routing::{get, Router};

use crate::proxy::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/observability/logs", get(super::spend_logs::list))
        .route(
            "/api/observability/logs/{request_id}",
            get(super::spend_logs::get),
        )
}
