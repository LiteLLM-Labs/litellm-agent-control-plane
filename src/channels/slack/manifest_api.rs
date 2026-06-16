use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::errors::GatewayError;

#[derive(Debug, Deserialize)]
pub struct SlackManifestCreateResponse {
    pub ok: bool,
    pub app_id: Option<String>,
    pub credentials: Option<SlackManifestCredentials>,
    pub oauth_authorize_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SlackManifestCredentials {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub signing_secret: Option<String>,
}

pub async fn manifest_create(
    client: &Client,
    api_base_url: &str,
    app_config_token: &str,
    manifest: Value,
    team_id: Option<&str>,
) -> Result<SlackManifestCreateResponse, GatewayError> {
    let manifest = serde_json::to_string(&manifest)?;
    let mut body = json!({ "manifest": manifest });
    if let Some(team_id) = team_id {
        body["team_id"] = team_id.into();
    }
    client
        .post(format!(
            "{}/apps.manifest.create",
            api_base_url.trim_end_matches('/')
        ))
        .bearer_auth(app_config_token)
        .json(&body)
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)
}
