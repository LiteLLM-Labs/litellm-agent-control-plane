use axum::http::{header::AUTHORIZATION, HeaderMap};

use crate::{errors::GatewayError, proxy::state::AppState};

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

pub fn require_any_gateway_key(headers: &HeaderMap, state: &AppState) -> Result<(), GatewayError> {
    let Some(master_key) = state.config.general_settings.master_key.as_deref() else {
        return Ok(());
    };

    if presented_key(headers) == Some(master_key) {
        return Ok(());
    }

    if presented_key(headers).is_some_and(|key| state.api_keys.accepts(key)) {
        Ok(())
    } else {
        Err(GatewayError::Unauthorized)
    }
}

fn presented_key(headers: &HeaderMap) -> Option<&str> {
    if let Some(bearer) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    {
        return Some(bearer);
    }

    headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
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
