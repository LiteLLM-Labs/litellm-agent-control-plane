use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};

use crate::{
    db::managed_agents::settings::repository as settings_repository,
    errors::GatewayError,
    proxy::{
        auth::master_key::require_master_key, config::validate_http_base_url, state::AppState,
    },
};

const ACTOR: &str = "admin";

#[derive(Debug, Deserialize)]
pub struct UpdateProxyBaseUrl {
    pub proxy_base_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProxyBaseUrlResponse {
    pub proxy_base_url: Option<String>,
    pub source: ProxyBaseUrlSource,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyBaseUrlSource {
    Database,
    Config,
    Unset,
}

pub async fn get_proxy_base_url(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<ProxyBaseUrlResponse>, GatewayError> {
    require_admin(&state, &headers)?;
    let database_value = if let Some(pool) = state.db.as_ref() {
        settings_repository::get_mcp_proxy_base_url(pool).await?
    } else {
        state.mcp_proxy_base_url_override()
    };
    state.set_mcp_proxy_base_url_override(database_value.clone());
    Ok(Json(proxy_base_url_response(&state, database_value)))
}

pub async fn update_proxy_base_url(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<UpdateProxyBaseUrl>,
) -> Result<Json<ProxyBaseUrlResponse>, GatewayError> {
    require_admin(&state, &headers)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let value = input
        .proxy_base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_proxy_base_url)
        .transpose()?;
    let database_value =
        settings_repository::set_mcp_proxy_base_url(pool, value.as_deref(), ACTOR).await?;
    state.set_mcp_proxy_base_url_override(database_value.clone());
    Ok(Json(proxy_base_url_response(&state, database_value)))
}

fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), GatewayError> {
    require_master_key(headers, state.config.general_settings.master_key.as_deref())
}

fn normalize_proxy_base_url(value: &str) -> Result<String, GatewayError> {
    validate_http_base_url("proxy_base_url", Some(value))
        .map_err(GatewayError::InvalidJsonMessage)?;
    let mut url = reqwest::Url::parse(value.trim()).map_err(|_| {
        GatewayError::InvalidJsonMessage(
            "proxy_base_url must be an absolute http(s) URL".to_owned(),
        )
    })?;
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn proxy_base_url_response(
    state: &AppState,
    database_value: Option<String>,
) -> ProxyBaseUrlResponse {
    if let Some(proxy_base_url) = database_value {
        return ProxyBaseUrlResponse {
            proxy_base_url: Some(proxy_base_url),
            source: ProxyBaseUrlSource::Database,
        };
    }

    if let Some(proxy_base_url) = state.configured_mcp_proxy_base_url() {
        return ProxyBaseUrlResponse {
            proxy_base_url: Some(proxy_base_url),
            source: ProxyBaseUrlSource::Config,
        };
    }

    ProxyBaseUrlResponse {
        proxy_base_url: None,
        source: ProxyBaseUrlSource::Unset,
    }
}
