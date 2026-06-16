use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::errors::GatewayError;

pub(crate) const MAX_TEXT_CHARS: usize = 4_096;

const GOOGLE_OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_CHAT_API_BASE: &str = "https://chat.googleapis.com/v1";
const CHAT_BOT_SCOPE: &str = "https://www.googleapis.com/auth/chat.bot";

#[derive(serde::Serialize)]
struct JwtClaims {
    iss: String,
    scope: String,
    aud: String,
    iat: u64,
    exp: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Deserialize)]
struct MessageResponse {
    name: Option<String>,
}

pub(crate) fn truncate(text: &str) -> String {
    text.chars().take(MAX_TEXT_CHARS).collect()
}

/// Parse a service account JSON key, build a signed JWT, and exchange it for
/// a Google OAuth2 access token with the `chat.bot` scope.
pub(crate) async fn access_token(
    client: &Client,
    service_account_json: &str,
) -> Result<String, GatewayError> {
    let sa: Value =
        serde_json::from_str(service_account_json).map_err(GatewayError::InvalidJson)?;

    let private_key = sa
        .get("private_key")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GatewayError::InvalidConfig("missing private_key in service account JSON".to_owned())
        })?;

    let client_email = sa
        .get("client_email")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GatewayError::InvalidConfig("missing client_email in service account JSON".to_owned())
        })?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let claims = JwtClaims {
        iss: client_email.to_owned(),
        scope: CHAT_BOT_SCOPE.to_owned(),
        aud: GOOGLE_OAUTH_TOKEN_URL.to_owned(),
        iat: now,
        exp: now + 3600,
    };

    let encoding_key = jsonwebtoken::EncodingKey::from_rsa_pem(private_key.as_bytes())
        .map_err(|_| GatewayError::Unauthorized)?;

    let jwt = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &encoding_key,
    )
    .map_err(|_| GatewayError::Unauthorized)?;

    let resp: TokenResponse = client
        .post(GOOGLE_OAUTH_TOKEN_URL)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &jwt),
        ])
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .error_for_status()
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)?;

    Ok(resp.access_token)
}

/// Create a message in a Google Chat space. Returns the message resource name
/// (e.g. `"spaces/AAAA/messages/YYYY"`).
///
/// * `space_name`  – e.g. `"spaces/AAAA"`
/// * `thread_name` – `Some("spaces/AAAA/threads/BBBB")` to reply in an
///   existing thread; `None` starts a new thread.
pub(crate) async fn create_message(
    client: &Client,
    token: &str,
    space_name: &str,
    thread_name: Option<&str>,
    text: &str,
) -> Result<String, GatewayError> {
    let url = format!(
        "{GOOGLE_CHAT_API_BASE}/{space_name}/messages\
         ?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
    );

    let body: Value = match thread_name {
        Some(thread) => json!({
            "text": truncate(text),
            "thread": { "name": thread }
        }),
        None => json!({ "text": truncate(text) }),
    };

    let resp: MessageResponse = client
        .post(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .error_for_status()
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)?;

    resp.name.ok_or_else(|| {
        GatewayError::InvalidConfig("create_message response missing name".to_owned())
    })
}

/// Update the text of an existing Google Chat message.
///
/// * `message_name` – e.g. `"spaces/AAAA/messages/CCCC"`
pub(crate) async fn update_message(
    client: &Client,
    token: &str,
    message_name: &str,
    text: &str,
) -> Result<(), GatewayError> {
    let url = format!("{GOOGLE_CHAT_API_BASE}/{message_name}?updateMask=text");

    let body = json!({ "text": truncate(text) });

    client
        .patch(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .error_for_status()
        .map_err(GatewayError::Upstream)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{truncate, MAX_TEXT_CHARS};

    #[test]
    fn truncate_uses_character_boundaries() {
        let text = format!("{}tail", "🙂".repeat(MAX_TEXT_CHARS + 1));
        let truncated = truncate(&text);

        assert_eq!(truncated.chars().count(), MAX_TEXT_CHARS);
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn truncate_preserves_exact_multibyte_limit() {
        let text = format!("{}€", "a".repeat(MAX_TEXT_CHARS - 1));

        assert_eq!(truncate(&text), text);
    }

    #[test]
    fn truncate_drops_trailing_text_after_multibyte_limit() {
        let text = format!("{}€z", "a".repeat(MAX_TEXT_CHARS - 1));
        let truncated = truncate(&text);

        assert_eq!(truncated.chars().count(), MAX_TEXT_CHARS);
        assert!(truncated.ends_with('€'));
        assert!(!truncated.ends_with('z'));
    }
}
