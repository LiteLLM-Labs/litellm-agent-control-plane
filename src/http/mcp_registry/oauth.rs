mod config;
mod flow_state;
mod token;

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{header::SET_COOKIE, HeaderMap, HeaderValue},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::mcp_servers::repository,
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, credential_crypto, state::AppState},
};

use config::{oauth_client_value, oauth_resource, oauth_scopes, required_server_url};
use flow_state::{redirect_target, safe_redirect_after, SignedOAuthState};
use token::{credential_from_token, exchange_code, store_oauth_credential};

pub(in crate::http::mcp_registry) use token::resolve_oauth_bearer_token;

#[derive(Debug, Deserialize)]
pub struct StartOAuthRequest {
    pub redirect_after: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StartOAuthResponse {
    pub authorization_url: String,
    pub redirect_uri: String,
}

#[derive(Debug, Deserialize)]
pub struct OAuthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

pub async fn start_oauth(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Json(input): Json<StartOAuthRequest>,
) -> Result<Response, GatewayError> {
    require_any_gateway_key(&headers, &state).await?;

    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let server = repository::get(pool, &server_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound(format!("MCP server not found: {server_id}")))?;
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let client_id = oauth_client_value(&server, &enc_key, &["oauth_client_id", "client_id"])
        .ok_or_else(|| {
            GatewayError::InvalidConfig("MCP OAuth client_id is not configured".to_owned())
        })?;
    let authorization_url = required_server_url(
        server.authorization_url.as_deref(),
        "MCP OAuth authorization_url is not configured",
    )?;
    let scopes = oauth_scopes(&server)?;
    let resource = oauth_resource(&server);
    let redirect_uri = format!("{}/v1/mcp/oauth/callback", flow_state::origin(&headers));
    let signed_state = SignedOAuthState {
        server_id,
        user_id: super::caller_user_id(&headers, &state),
        redirect_after: input.redirect_after,
        redirect_uri: redirect_uri.clone(),
        nonce: uuid::Uuid::new_v4().simple().to_string(),
        iat_ms: flow_state::now_ms(),
    };
    let encoded_state = flow_state::encode_state(&signed_state, &enc_key)?;
    let authorization_url = flow_state::authorization_url(
        authorization_url,
        &client_id,
        &redirect_uri,
        &scopes,
        resource.as_deref(),
        &encoded_state,
    )?;

    let mut response = Json(StartOAuthResponse {
        authorization_url,
        redirect_uri,
    })
    .into_response();
    insert_set_cookie(
        &mut response,
        flow_state::callback_cookie(&encoded_state, &signed_state.redirect_uri),
    )?;
    Ok(response)
}

pub async fn oauth_callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<OAuthCallbackQuery>,
) -> Result<Response, GatewayError> {
    let context = match callback_context(&state, &headers, &query) {
        Ok(value) => value,
        Err(redirect) => return Ok(redirect.response()),
    };

    if let Some(error) = query.error {
        let message = query.error_description.unwrap_or(error);
        return Ok(callback_redirect(
            &context.redirect_after,
            "failed",
            &context.signed_state.server_id,
            Some(&message),
        ));
    }

    let Some(code) = query.code.as_deref() else {
        return Ok(callback_redirect(
            &context.redirect_after,
            "failed",
            &context.signed_state.server_id,
            Some("Missing OAuth code"),
        ));
    };

    let result = complete_oauth_callback(&state, &context, code).await;
    Ok(match result {
        Ok(()) => callback_redirect(
            &context.redirect_after,
            "connected",
            &context.signed_state.server_id,
            None,
        ),
        Err(error) => callback_redirect(
            &context.redirect_after,
            "failed",
            &context.signed_state.server_id,
            Some(&error.to_string()),
        ),
    })
}

struct OAuthCallbackContext {
    enc_key: String,
    signed_state: SignedOAuthState,
    redirect_after: String,
}

fn callback_context(
    state: &AppState,
    headers: &HeaderMap,
    query: &OAuthCallbackQuery,
) -> Result<OAuthCallbackContext, CallbackRedirect> {
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())
            .map_err(|_| CallbackRedirect::fallback("unknown", "OAuth is not configured"))?;
    let state_value = query
        .state
        .as_deref()
        .ok_or_else(|| CallbackRedirect::fallback("unknown", "Missing OAuth state"))?;
    let signed_state = flow_state::decode_state(state_value, &enc_key)
        .map_err(|_| CallbackRedirect::fallback("unknown", "Invalid OAuth state"))?;
    let redirect_after = safe_redirect_after(signed_state.redirect_after.as_deref());
    if !flow_state::callback_cookie_matches(headers, state_value) {
        return Err(CallbackRedirect {
            redirect_after,
            server_id: signed_state.server_id,
            error: "OAuth session expired. Try connecting again.",
        });
    }
    Ok(OAuthCallbackContext {
        enc_key,
        signed_state,
        redirect_after,
    })
}

struct CallbackRedirect {
    redirect_after: String,
    server_id: String,
    error: &'static str,
}

impl CallbackRedirect {
    fn fallback(server_id: &str, error: &'static str) -> Self {
        Self {
            redirect_after: "/integrations".to_owned(),
            server_id: server_id.to_owned(),
            error,
        }
    }

    fn response(self) -> Response {
        callback_redirect(
            &self.redirect_after,
            "failed",
            &self.server_id,
            Some(self.error),
        )
    }
}

async fn complete_oauth_callback(
    state: &AppState,
    context: &OAuthCallbackContext,
    code: &str,
) -> Result<(), GatewayError> {
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let server = repository::get(pool, &context.signed_state.server_id)
        .await?
        .ok_or_else(|| {
            GatewayError::NotFound(format!(
                "MCP server not found: {}",
                context.signed_state.server_id
            ))
        })?;
    let token = exchange_code(
        state,
        &server,
        &context.enc_key,
        code,
        &context.signed_state.redirect_uri,
    )
    .await?;
    let credential = credential_from_token(token, None)?;
    store_oauth_credential(
        pool,
        state,
        &context.signed_state.server_id,
        &context.signed_state.user_id,
        &credential,
    )
    .await
}

fn callback_redirect(
    redirect_after: &str,
    status: &str,
    server_id: &str,
    error: Option<&str>,
) -> Response {
    let target = redirect_target(redirect_after, status, server_id, error);
    let mut response = Redirect::to(&target).into_response();
    response.headers_mut().insert(
        SET_COOKIE,
        HeaderValue::from_static(flow_state::clear_callback_cookie()),
    );
    response
}

fn insert_set_cookie(response: &mut Response, value: String) -> Result<(), GatewayError> {
    let value = HeaderValue::from_str(&value).map_err(|_| {
        GatewayError::InvalidConfig("OAuth callback cookie value is invalid".to_owned())
    })?;
    response.headers_mut().insert(SET_COOKIE, value);
    Ok(())
}
