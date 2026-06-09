use crate::{
    errors::GatewayError,
    proxy::{provider_credentials, state::AppState},
    sdk::routing::Route,
};

pub async fn apply(state: &AppState, mut route: Route) -> Result<Route, GatewayError> {
    let Some(pool) = state.db.as_ref() else {
        ensure_key(&route)?;
        return Ok(route);
    };
    if let Some(credential) =
        provider_credentials::load(pool, &state.config, &route.deployment.provider_id).await?
    {
        route.deployment.api_key = credential.api_key;
        route.deployment.api_base = credential.api_base;
    }
    ensure_key(&route)?;
    Ok(route)
}

fn ensure_key(route: &Route) -> Result<(), GatewayError> {
    if route.deployment.api_key.trim().is_empty() {
        return Err(GatewayError::InvalidConfig(format!(
            "{} provider credentials are not configured",
            route.deployment.provider_id
        )));
    }
    Ok(())
}
