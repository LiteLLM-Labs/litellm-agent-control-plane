use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::http::{header::AUTHORIZATION, HeaderMap};
use serde::Deserialize;

use crate::{errors::GatewayError, proxy::state::AppState};

// Cache litellm key validation results for 60 s to avoid a round-trip on every request.
static LITELLM_KEY_CACHE: Mutex<Option<HashMap<String, (Instant, bool)>>> = Mutex::new(None);
const CACHE_TTL: Duration = Duration::from_secs(60);

pub fn require_master_key(
    headers: &HeaderMap,
    configured: Option<&str>,
) -> Result<(), GatewayError> {
    let Some(master_key) = configured else {
        return Ok(());
    };

    if presented_key(headers) == Some(master_key) {
        Ok(())
    } else {
        Err(GatewayError::Unauthorized)
    }
}

pub async fn require_any_gateway_key(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<(), GatewayError> {
    let master_key = state.config.general_settings.master_key.as_deref();

    // No auth configured — allow all.
    let Some(configured_master_key) = master_key else {
        return Ok(());
    };

    let Some(key) = presented_key(headers) else {
        return Err(GatewayError::Unauthorized);
    };

    // Fast path: local master key.
    if key == configured_master_key {
        return Ok(());
    }

    // Fast path: locally-created API key.
    if state.api_keys.accepts(key) {
        return Ok(());
    }

    // Slow path: validate against litellm if configured.
    if let Some(base_url) = state.config.general_settings.litellm_base_url.as_deref() {
        if validate_with_litellm(key, base_url, &state.http).await {
            return Ok(());
        }
    }

    Err(GatewayError::Unauthorized)
}

/// Call litellm's /key/info to validate a foreign key.
/// Results are cached for CACHE_TTL to reduce latency.
async fn validate_with_litellm(key: &str, base_url: &str, client: &reqwest::Client) -> bool {
    // Check cache first.
    {
        let mut guard = LITELLM_KEY_CACHE.lock().unwrap();
        let cache = guard.get_or_insert_with(HashMap::new);
        if let Some((ts, result)) = cache.get(key) {
            if ts.elapsed() < CACHE_TTL {
                return *result;
            }
            cache.remove(key);
        }
    }

    let url = format!("{}/key/info", base_url.trim_end_matches('/'));
    let result = client
        .get(&url)
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    {
        let mut guard = LITELLM_KEY_CACHE.lock().unwrap();
        let cache = guard.get_or_insert_with(HashMap::new);
        cache.insert(key.to_owned(), (Instant::now(), result));
    }

    result
}

pub fn presented_key(headers: &HeaderMap) -> Option<&str> {
    if let Some(bearer) = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        return Some(bearer);
    }
    headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderMap;

    use super::require_master_key;

    fn headers(name: &'static str, value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(name, value.parse().unwrap());
        h
    }

    #[test]
    fn accepts_authorization_bearer() {
        let h = headers("authorization", "Bearer sk-local");
        assert!(require_master_key(&h, Some("sk-local")).is_ok());
    }

    #[test]
    fn accepts_x_api_key() {
        let h = headers("x-api-key", "sk-local");
        assert!(require_master_key(&h, Some("sk-local")).is_ok());
    }

    #[test]
    fn rejects_wrong_key() {
        let h = headers("x-api-key", "nope");
        assert!(require_master_key(&h, Some("sk-local")).is_err());
    }

    #[test]
    fn rejects_missing_header() {
        assert!(require_master_key(&HeaderMap::new(), Some("sk-local")).is_err());
    }

    #[test]
    fn no_master_key_configured_allows_all() {
        assert!(require_master_key(&HeaderMap::new(), None).is_ok());
    }
}
