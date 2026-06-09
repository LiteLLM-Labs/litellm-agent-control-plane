use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, Json};
use serde_json::{json, Value};

use crate::{
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

pub async fn models(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;

    let data: Vec<Value> = state
        .config
        .model_list
        .iter()
        .map(|entry| {
            json!({
                "id": entry.model_name,
                "object": "model",
                "owned_by": "litellm",
            })
        })
        .collect();

    Ok(Json(json!({ "object": "list", "data": data })))
}
