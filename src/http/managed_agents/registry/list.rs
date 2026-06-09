use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};

use crate::{
    db::managed_agents::registry::repository,
    errors::GatewayError,
    http::agents::configured_agent_values,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

use super::types::{AgentsResponse, ListAgentsQuery};

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ListAgentsQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;

    let mut agents = configured_agent_values(&state);
    if let Some(pool) = state.db.as_ref() {
        agents.extend(
            repository::list(pool, query.owner_id.as_deref())
                .await?
                .into_iter()
                .map(serde_json::to_value)
                .collect::<Result<Vec<_>, _>>()?,
        );
    } else if agents.is_empty() {
        return Err(GatewayError::MissingDatabase);
    }

    Ok(Json(serde_json::json!(AgentsResponse { agents })))
}
