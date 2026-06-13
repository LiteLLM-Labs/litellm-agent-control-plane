use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};

use jsonwebtoken::{decode, decode_header, jwk::Jwk, Algorithm, DecodingKey, Validation};
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;

use crate::errors::GatewayError;

const OPENID_METADATA_URL: &str =
    "https://login.botframework.com/v1/.well-known/openidconfiguration";
const BOT_CONNECTOR_ISSUER: &str = "https://api.botframework.com";
pub(crate) const TEAMS_CHANNEL_ID: &str = "msteams";
const KEY_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

static CONNECTOR_KEYS: OnceLock<tokio::sync::RwLock<Option<CachedKeys>>> = OnceLock::new();

#[derive(Debug, Deserialize)]
struct OpenIdMetadata {
    jwks_uri: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RawJwkSet {
    keys: Vec<Value>,
}

#[derive(Debug, Clone)]
struct CachedKeys {
    keys: RawJwkSet,
    fetched_at: Instant,
}

#[derive(Debug, Deserialize)]
struct ConnectorClaims {
    iss: String,
    aud: String,
    #[serde(default)]
    serviceurl: Option<String>,
}

pub(crate) async fn verify_connector_request(
    client: &Client,
    authorization: Option<&str>,
    app_id: &str,
    service_url: &str,
) -> Result<(), GatewayError> {
    let token = bearer_token(authorization)?;
    let header = decode_header(token).map_err(|_| GatewayError::Unauthorized)?;
    let key_id = header
        .kid
        .or(header.x5t)
        .ok_or(GatewayError::Unauthorized)?;
    let mut keys = connector_keys(client, false).await?;
    let mut key_value = keys
        .keys
        .iter()
        .find(|key| key_matches(key, &key_id))
        .cloned();
    if key_value.is_none() {
        keys = connector_keys(client, true).await?;
        key_value = keys
            .keys
            .iter()
            .find(|key| key_matches(key, &key_id))
            .cloned();
    }
    let key_value = key_value.ok_or(GatewayError::Unauthorized)?;
    require_teams_endorsement(&key_value)?;
    let jwk: Jwk = serde_json::from_value(key_value).map_err(GatewayError::InvalidJson)?;
    let key = DecodingKey::from_jwk(&jwk).map_err(|_| GatewayError::Unauthorized)?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[app_id]);
    validation.set_issuer(&[BOT_CONNECTOR_ISSUER]);
    validation.leeway = 300;
    validation.validate_nbf = true;
    let data = decode::<ConnectorClaims>(token, &key, &validation)
        .map_err(|_| GatewayError::Unauthorized)?;
    if data.claims.iss != BOT_CONNECTOR_ISSUER || data.claims.aud != app_id {
        return Err(GatewayError::Unauthorized);
    }
    if data.claims.serviceurl.as_deref() != Some(service_url) {
        return Err(GatewayError::Unauthorized);
    }
    Ok(())
}

fn bearer_token(authorization: Option<&str>) -> Result<&str, GatewayError> {
    authorization
        .and_then(|value| value.trim().strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(GatewayError::Unauthorized)
}

async fn connector_keys(client: &Client, force_refresh: bool) -> Result<RawJwkSet, GatewayError> {
    let cache = CONNECTOR_KEYS.get_or_init(|| tokio::sync::RwLock::new(None));
    if !force_refresh {
        if let Some(cached) = cache.read().await.as_ref() {
            if cached.fetched_at.elapsed() < KEY_CACHE_TTL {
                return Ok(cached.keys.clone());
            }
        }
    }
    let fresh = fetch_connector_keys(client).await?;
    *cache.write().await = Some(CachedKeys {
        keys: fresh.clone(),
        fetched_at: Instant::now(),
    });
    Ok(fresh)
}

async fn fetch_connector_keys(client: &Client) -> Result<RawJwkSet, GatewayError> {
    let metadata: OpenIdMetadata = client
        .get(OPENID_METADATA_URL)
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)?;
    client
        .get(metadata.jwks_uri)
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)
}

fn key_matches(key: &Value, key_id: &str) -> bool {
    key.get("kid").and_then(Value::as_str) == Some(key_id)
        || key.get("x5t").and_then(Value::as_str) == Some(key_id)
}

fn require_teams_endorsement(key: &Value) -> Result<(), GatewayError> {
    let endorsed = key
        .get("endorsements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|value| value.as_str() == Some(TEAMS_CHANNEL_ID));
    match endorsed {
        true => Ok(()),
        false => Err(GatewayError::Unauthorized),
    }
}
