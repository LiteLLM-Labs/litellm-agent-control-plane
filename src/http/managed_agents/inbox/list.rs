use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};

use crate::{db::managed_agents::inbox::repository, errors::GatewayError, proxy::state::AppState};

use super::types::{InboxResponse, ListInboxQuery};

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ListInboxQuery>,
) -> Result<Json<InboxResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    Ok(Json(InboxResponse {
        items: repository::list(pool, query.filter.as_deref().unwrap_or("all")).await?,
    }))
}
