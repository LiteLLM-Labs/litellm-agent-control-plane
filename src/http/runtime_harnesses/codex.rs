use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::{
    db::{credentials, managed_agents::harnesses},
    errors::GatewayError,
    http::runtime_resolution::harness_credential_name,
    proxy::{auth::master_key::require_any_gateway_key, credential_crypto, state::AppState},
    sdk::agents::CLAUDE_MANAGED_AGENTS,
};

use super::{build_harnesses_list, helpers, validate_alias, HarnessesResponse};

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    controller_alias: String,
    #[serde(flatten)]
    profile: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
pub struct CancelLoginRequest {
    #[serde(rename = "loginId")]
    login_id: String,
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut input): Json<CreateRequest>,
) -> Result<Json<HarnessesResponse>, GatewayError> {
    require_any_gateway_key(&headers, &state).await?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let alias = input
        .profile
        .get("alias")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    validate_alias(&alias)?;
    if harnesses::repository::get_by_alias(pool, &alias)
        .await?
        .is_some()
    {
        return Err(GatewayError::InvalidJsonMessage(format!(
            "harness alias already exists: {alias}"
        )));
    }
    let profile_type = input
        .profile
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GatewayError::InvalidJsonMessage("Codex profile type is required".to_owned())
        })?
        .to_owned();
    if !matches!(profile_type.as_str(), "api" | "chatgpt" | "remote_ssh") {
        return Err(GatewayError::InvalidJsonMessage(
            "unknown Codex profile type".to_owned(),
        ));
    }

    let (controller_key, controller_base) =
        controller_credential(&state, pool, &input.controller_alias).await?;
    input.profile.remove("controller_alias");
    let upstream = send_control(
        &state,
        reqwest::Method::POST,
        &controller_base,
        "profiles",
        &controller_key,
        Some(Value::Object(input.profile)),
    )
    .await?;
    let created = upstream
        .get("profile")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            GatewayError::InvalidJsonMessage(
                "Codex controller returned an invalid profile".to_owned(),
            )
        })?;
    if created.get("alias").and_then(Value::as_str) != Some(alias.as_str()) {
        return Err(GatewayError::InvalidJsonMessage(
            "Codex controller returned the wrong profile alias".to_owned(),
        ));
    }

    let child_base = format!(
        "{}/profiles/{}",
        controller_base.trim_end_matches('/'),
        alias
    );
    if let Err(error) =
        harnesses::repository::create(pool, &alias, CLAUDE_MANAGED_AGENTS, &child_base).await
    {
        let _ = send_control(
            &state,
            reqwest::Method::DELETE,
            &controller_base,
            &format!("profiles/{alias}"),
            &controller_key,
            None,
        )
        .await;
        return Err(error);
    }
    let encryption_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let values = json!({
        "api_key": credential_crypto::encrypt_value(&controller_key, &encryption_key)?,
        "api_base": credential_crypto::encrypt_value(&child_base, &encryption_key)?,
        "codex_profile_type": profile_type,
        "codex_controller_alias": input.controller_alias,
    });
    if let Err(error) = credentials::upsert(
        pool,
        &harness_credential_name(&alias),
        values,
        json!({}),
        "ui",
    )
    .await
    {
        let _ = harnesses::repository::delete(pool, &alias).await;
        let _ = send_control(
            &state,
            reqwest::Method::DELETE,
            &controller_base,
            &format!("profiles/{alias}"),
            &controller_key,
            None,
        )
        .await;
        return Err(error);
    }

    Ok(Json(HarnessesResponse {
        harnesses: build_harnesses_list(&state, pool).await?,
    }))
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(controller_alias): Path<String>,
) -> Result<Json<Value>, GatewayError> {
    require_any_gateway_key(&headers, &state).await?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let (key, base) = controller_credential(&state, pool, &controller_alias).await?;
    Ok(Json(
        send_control(&state, reqwest::Method::GET, &base, "profiles", &key, None).await?,
    ))
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((controller_alias, alias)): Path<(String, String)>,
) -> Result<Json<Value>, GatewayError> {
    require_any_gateway_key(&headers, &state).await?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let child_credential = credentials::get_by_name(pool, &harness_credential_name(&alias))
        .await?
        .ok_or_else(|| {
            GatewayError::NotFound(format!("Codex profile runtime not found: {alias}"))
        })?;
    let child_values = child_credential
        .credential_values
        .as_object()
        .ok_or_else(|| {
            GatewayError::InvalidConfig("harness credential_values must be an object".to_owned())
        })?;
    let (_, stored_controller) =
        helpers::codex_profile_metadata(child_values).ok_or_else(|| {
            GatewayError::InvalidJsonMessage(format!("runtime {alias} is not a Codex profile"))
        })?;
    if stored_controller != controller_alias {
        return Err(GatewayError::InvalidJsonMessage(format!(
            "Codex profile {alias} belongs to controller {stored_controller}"
        )));
    }
    let (key, base) = controller_credential(&state, pool, &controller_alias).await?;
    match send_control(
        &state,
        reqwest::Method::DELETE,
        &base,
        &format!("profiles/{alias}"),
        &key,
        None,
    )
    .await
    {
        Ok(_) | Err(GatewayError::NotFound(_)) => {}
        Err(error) => return Err(error),
    }
    harnesses::repository::delete(pool, &alias).await?;
    let _ = credentials::delete_by_name(pool, &harness_credential_name(&alias)).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn read_account(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((controller_alias, alias)): Path<(String, String)>,
) -> Result<Json<Value>, GatewayError> {
    proxy_profile_action(
        &state,
        &headers,
        &controller_alias,
        &alias,
        "account",
        reqwest::Method::GET,
        None,
    )
    .await
}

pub async fn login_start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((controller_alias, alias)): Path<(String, String)>,
) -> Result<Json<Value>, GatewayError> {
    proxy_profile_action(
        &state,
        &headers,
        &controller_alias,
        &alias,
        "login/start",
        reqwest::Method::POST,
        Some(json!({})),
    )
    .await
}

pub async fn cancel_login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((controller_alias, alias)): Path<(String, String)>,
    Json(input): Json<CancelLoginRequest>,
) -> Result<Json<Value>, GatewayError> {
    proxy_profile_action(
        &state,
        &headers,
        &controller_alias,
        &alias,
        "login/cancel",
        reqwest::Method::POST,
        Some(json!({ "loginId": input.login_id })),
    )
    .await
}

pub async fn logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((controller_alias, alias)): Path<(String, String)>,
) -> Result<Json<Value>, GatewayError> {
    proxy_profile_action(
        &state,
        &headers,
        &controller_alias,
        &alias,
        "logout",
        reqwest::Method::POST,
        Some(json!({})),
    )
    .await
}

async fn proxy_profile_action(
    state: &AppState,
    headers: &HeaderMap,
    controller_alias: &str,
    alias: &str,
    action: &str,
    method: reqwest::Method,
    body: Option<Value>,
) -> Result<Json<Value>, GatewayError> {
    require_any_gateway_key(headers, state).await?;
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let (key, base) = controller_credential(state, pool, controller_alias).await?;
    Ok(Json(
        send_control(
            state,
            method,
            &base,
            &format!("profiles/{alias}/{action}"),
            &key,
            body,
        )
        .await?,
    ))
}

async fn controller_credential(
    state: &AppState,
    pool: &sqlx::PgPool,
    alias: &str,
) -> Result<(String, String), GatewayError> {
    let row = harnesses::repository::get_by_alias(pool, alias)
        .await?
        .ok_or_else(|| {
            GatewayError::NotFound(format!("Codex controller runtime not found: {alias}"))
        })?;
    let encryption_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let (api_key, api_base, _, _) =
        helpers::load_harness_api_key(pool, alias, &encryption_key).await?;
    if api_base.contains("/profiles/") {
        return Err(GatewayError::InvalidJsonMessage(format!(
            "runtime {alias} is a Codex profile, not a controller"
        )));
    }
    if row.api_spec != CLAUDE_MANAGED_AGENTS {
        return Err(GatewayError::InvalidJsonMessage(format!(
            "runtime {alias} does not use the Managed Agents API"
        )));
    }
    Ok((api_key, api_base))
}

async fn send_control(
    state: &AppState,
    method: reqwest::Method,
    base: &str,
    path: &str,
    key: &str,
    body: Option<Value>,
) -> Result<Value, GatewayError> {
    let url = format!(
        "{}/control/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    let mut request = state.http.request(method, url).header("x-api-key", key);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(GatewayError::Upstream)?;
    let status = response.status();
    let payload: Value = response.json().await.map_err(GatewayError::Upstream)?;
    if !status.is_success() {
        let message = payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Codex controller request failed");
        return Err(if status == reqwest::StatusCode::NOT_FOUND {
            GatewayError::NotFound(message.to_owned())
        } else {
            GatewayError::InvalidJsonMessage(message.to_owned())
        });
    }
    Ok(payload)
}
