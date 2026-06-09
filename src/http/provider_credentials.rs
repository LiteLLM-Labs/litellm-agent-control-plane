use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::credentials,
    errors::GatewayError,
    proxy::{
        auth::master_key::require_master_key,
        provider_credentials::{
            self, credential_name, ProviderCategory, ProviderCredentialInput, PROVIDER_CATALOG,
        },
        state::AppState,
    },
};

#[derive(Debug, Serialize)]
pub struct ProvidersResponse {
    pub available_providers: Vec<AvailableProvider>,
    pub connected_providers: Vec<ConnectedProvider>,
}

#[derive(Debug, Serialize)]
pub struct AvailableProvider {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_base_url: String,
    pub category: ProviderCategory,
}

#[derive(Debug, Serialize)]
pub struct ConnectedProvider {
    pub id: String,
    pub name: String,
    pub api_base: String,
    pub masked_api_key: String,
    pub category: ProviderCategory,
}

#[derive(Debug, Deserialize)]
pub struct SaveProviderRequest {
    pub api_key: String,
    pub api_base: String,
}

#[derive(Debug, Serialize)]
pub struct DeleteProviderResponse {
    pub ok: bool,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    require_admin(&state, &headers)?;
    Ok(Json(response(&state).await?))
}

pub async fn save_provider(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
    Json(input): Json<SaveProviderRequest>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    require_admin(&state, &headers)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let api_key = required(input.api_key, "api_key")?;
    let api_base = required(input.api_base, "api_base")?;
    provider_credentials::save(
        pool,
        &state.config,
        &provider_id,
        ProviderCredentialInput { api_key, api_base },
    )
    .await?;
    Ok(Json(response(&state).await?))
}

pub async fn delete_provider(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
) -> Result<Json<DeleteProviderResponse>, GatewayError> {
    require_admin(&state, &headers)?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    provider_credentials::catalog_entry(&provider_id)?;
    Ok(Json(DeleteProviderResponse {
        ok: credentials::delete_by_name(pool, &credential_name(&provider_id)).await?,
    }))
}

async fn response(state: &AppState) -> Result<ProvidersResponse, GatewayError> {
    Ok(ProvidersResponse {
        available_providers: PROVIDER_CATALOG
            .iter()
            .map(|provider| AvailableProvider {
                id: provider.id.to_owned(),
                name: provider.name.to_owned(),
                description: provider.description.to_owned(),
                default_base_url: provider.default_base_url.to_owned(),
                category: provider.category,
            })
            .collect(),
        connected_providers: connected_providers(state).await?,
    })
}

async fn connected_providers(state: &AppState) -> Result<Vec<ConnectedProvider>, GatewayError> {
    let Some(pool) = state.db.as_ref() else {
        return Ok(Vec::new());
    };
    let mut connected = Vec::new();
    for provider in PROVIDER_CATALOG {
        let Some(credential) = provider_credentials::load(pool, &state.config, provider.id).await?
        else {
            continue;
        };
        connected.push(ConnectedProvider {
            id: provider.id.to_owned(),
            name: provider.name.to_owned(),
            api_base: credential.api_base,
            masked_api_key: provider_credentials::mask_api_key(&credential.api_key),
            category: provider.category,
        });
    }
    Ok(connected)
}

fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), GatewayError> {
    require_master_key(headers, state.config.general_settings.master_key.as_deref())
}

fn required(value: String, field: &str) -> Result<String, GatewayError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(GatewayError::InvalidJsonMessage(format!(
            "{field} is required"
        )));
    }
    Ok(trimmed.to_owned())
}
