pub mod files;
pub mod inbox;
pub mod memory;
pub mod registry;
pub mod routes;
pub mod routines;
pub mod rules;
pub mod runs;
pub mod skills;
pub mod slack;

use axum::http::HeaderMap;
use sqlx::PgPool;

use crate::{
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
};

pub fn db<'a>(state: &'a AppState, headers: &HeaderMap) -> Result<&'a PgPool, GatewayError> {
    require_any_gateway_key(headers, state)?;

    state.db.as_ref().ok_or(GatewayError::MissingDatabase)
}
