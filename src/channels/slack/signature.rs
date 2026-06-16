use axum::http::HeaderMap;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::errors::GatewayError;

const VERSION: &str = "v0";
const MAX_CLOCK_SKEW_SECONDS: i64 = 60 * 5;

pub fn verify(headers: &HeaderMap, body: &[u8], signing_secret: &str) -> Result<(), GatewayError> {
    let timestamp = header(headers, "x-slack-request-timestamp")
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or(GatewayError::Unauthorized)?;
    if (now_seconds() - timestamp).abs() > MAX_CLOCK_SKEW_SECONDS {
        return Err(GatewayError::Unauthorized);
    }
    let presented = header(headers, "x-slack-signature").ok_or(GatewayError::Unauthorized)?;
    let expected = signature(timestamp, body, signing_secret)?;
    if constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
        Ok(())
    } else {
        Err(GatewayError::Unauthorized)
    }
}

pub fn signature(
    timestamp: i64,
    body: &[u8],
    signing_secret: &str,
) -> Result<String, GatewayError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(signing_secret.as_bytes())
        .map_err(|_| GatewayError::InvalidConfig("invalid slack signing secret".to_owned()))?;
    mac.update(format!("{VERSION}:{timestamp}:").as_bytes());
    mac.update(body);
    Ok(format!(
        "{VERSION}={}",
        lower_hex(&mac.finalize().into_bytes())
    ))
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderMap;

    use super::{signature, verify};

    #[test]
    fn verifies_slack_signature() {
        let body = br#"{"type":"url_verification","challenge":"ok"}"#;
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let sig = signature(timestamp, body, "secret").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-slack-request-timestamp", timestamp.into());
        headers.insert("x-slack-signature", sig.parse().unwrap());
        assert!(verify(&headers, body, "secret").is_ok());
    }
}
