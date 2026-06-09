use base64::{engine::general_purpose, Engine};
use crypto_secretbox::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Key, Nonce, XSalsa20Poly1305,
};
use sha2::{Digest, Sha256};

use crate::errors::GatewayError;

const NONCE_LEN: usize = 24;

pub fn encryption_key(master_key: Option<&str>) -> Result<String, GatewayError> {
    if let Ok(salt_key) = std::env::var("LITELLM_SALT_KEY") {
        if !salt_key.trim().is_empty() {
            return Ok(salt_key);
        }
    }
    master_key
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            GatewayError::InvalidConfig(
                "LITELLM_SALT_KEY or general_settings.master_key is required".to_owned(),
            )
        })
}

pub fn encrypt_value(value: &str, signing_key: &str) -> Result<String, GatewayError> {
    let nonce = XSalsa20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher(signing_key)
        .encrypt(&nonce, value.as_bytes())
        .map_err(|_| {
            GatewayError::InvalidConfig("provider credential encryption failed".to_owned())
        })?;
    let mut encrypted = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    encrypted.extend_from_slice(&nonce);
    encrypted.extend_from_slice(&ciphertext);
    Ok(general_purpose::URL_SAFE.encode(encrypted))
}

pub fn decrypt_value(value: &str, signing_key: &str) -> Result<String, GatewayError> {
    let encrypted = general_purpose::URL_SAFE
        .decode(value)
        .or_else(|_| general_purpose::STANDARD.decode(value))
        .map_err(|_| invalid_encrypted_value())?;
    let (nonce, ciphertext) = encrypted
        .split_at_checked(NONCE_LEN)
        .ok_or_else(invalid_encrypted_value)?;
    let plaintext = cipher(signing_key)
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| invalid_encrypted_value())?;
    String::from_utf8(plaintext).map_err(|_| invalid_encrypted_value())
}

fn cipher(signing_key: &str) -> XSalsa20Poly1305 {
    let digest = Sha256::digest(signing_key.as_bytes());
    XSalsa20Poly1305::new(Key::from_slice(&digest))
}

fn invalid_encrypted_value() -> GatewayError {
    GatewayError::InvalidConfig("provider credential decryption failed".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{decrypt_value, encrypt_value};

    #[test]
    fn round_trips_secretbox_value() {
        let encrypted = encrypt_value("sk-ant-test", "salt").unwrap();
        assert_ne!(encrypted, "sk-ant-test");
        assert_eq!(decrypt_value(&encrypted, "salt").unwrap(), "sk-ant-test");
    }
}
