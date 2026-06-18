use axum::{http::StatusCode, Json};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::Digest as _;

const PLUGIN_NAME: &str = "litellm-platform-plugin";
const CLAIM_TTL_SECS: u64 = 30;

#[derive(Deserialize)]
pub struct PluginAuthRequest {
    session_claim: String,
}

#[derive(Serialize)]
pub struct PluginAuthResponse {
    /// The LAP master key — returned only after claim verification so the
    /// browser never receives it without a valid litellm proxy assertion.
    token: String,
    /// Caller's role as asserted by the litellm proxy.
    user_role: String,
    /// Caller's user-id as asserted by the litellm proxy.
    user_id: String,
}

/// Verify a plugin session claim delivered from the litellm parent frame.
///
/// The claim is a Fernet token encrypted with a key derived from
/// HMAC(LITELLM_SALT_KEY, plugin_name).  It contains
///   {user_id, user_role, plugin, exp}
/// but does NOT contain a litellm bearer token, so a compromised plugin
/// cannot act as the user against the proxy.
pub async fn plugin_auth(
    Json(body): Json<PluginAuthRequest>,
) -> Result<Json<PluginAuthResponse>, StatusCode> {
    let salt_key = std::env::var("LITELLM_SALT_KEY").unwrap_or_default();
    if salt_key.is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    let json_str = fernet_decrypt_plugin_scoped(&body.session_claim, &salt_key, PLUGIN_NAME)
        .map_err(|_| StatusCode::UNAUTHORIZED)?;

    let claim: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|_| StatusCode::BAD_REQUEST)?;

    // Validate audience
    if claim.get("plugin").and_then(|v| v.as_str()) != Some(PLUGIN_NAME) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Validate expiry (belt-and-suspenders alongside Fernet TTL)
    let exp = claim.get("exp").and_then(|v| v.as_u64()).unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if now > exp || exp - now > CLAIM_TTL_SECS {
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Return the LAP's own master key so the browser can authenticate against
    // the LAP.  This key is never exposed without a valid claim from the proxy.
    let lap_master_key = std::env::var("LITELLM_MASTER_KEY").unwrap_or_default();

    Ok(Json(PluginAuthResponse {
        token: lap_master_key,
        user_role: claim
            .get("user_role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned(),
        user_id: claim
            .get("user_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned(),
    }))
}

/// Fernet decryption with a plugin-scoped key.
///
/// Key = HMAC-SHA256(LITELLM_SALT_KEY, plugin_name)[..32] base64url-encoded.
/// This mirrors Python: `_hmac.new(salt.encode(), plugin.encode(), sha256).digest()`.
fn fernet_decrypt_plugin_scoped(
    token: &str,
    salt_key: &str,
    plugin_name: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;
    type HmacSha256 = Hmac<Sha256>;

    // Derive plugin-scoped 32-byte key via HMAC(salt, plugin_name)
    let mut mac = HmacSha256::new_from_slice(salt_key.as_bytes())?;
    mac.update(plugin_name.as_bytes());
    let raw_key = mac.finalize().into_bytes();
    let signing_key = &raw_key[..16];
    let encryption_key = &raw_key[16..];

    // Decode Fernet token (url-safe base64, no padding)
    let data = URL_SAFE_NO_PAD.decode(token.trim_end_matches('='))?;
    if data.len() < 1 + 8 + 16 + 32 {
        return Err("token too short".into());
    }
    if data[0] != 0x80 {
        return Err("unsupported fernet version".into());
    }

    let hmac_start = data.len() - 32;
    let payload = &data[..hmac_start];
    let expected_hmac = &data[hmac_start..];

    // Verify HMAC-SHA256
    let mut verify_mac = HmacSha256::new_from_slice(signing_key)?;
    verify_mac.update(payload);
    verify_mac
        .verify_slice(expected_hmac)
        .map_err(|_| "hmac mismatch")?;

    // Check Fernet timestamp (8 bytes big-endian at offset 1)
    let ts = u64::from_be_bytes(data[1..9].try_into()?);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if now.saturating_sub(ts) > CLAIM_TTL_SECS {
        return Err("claim expired".into());
    }

    // Decrypt AES-128-CBC
    let iv = &data[9..25];
    let ciphertext = &data[25..hmac_start];
    let mut buf = ciphertext.to_vec();
    let plaintext = Aes128CbcDec::new(encryption_key.into(), iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| "decrypt failed")?;

    Ok(String::from_utf8(plaintext.to_vec())?)
}
