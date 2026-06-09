use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct GatewayApiKeyMetadata {
    pub id: String,
    pub label: Option<String>,
    pub created_at: u64,
    pub last_used_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreatedGatewayApiKey {
    #[serde(flatten)]
    pub metadata: GatewayApiKeyMetadata,
    pub key: String,
}

#[derive(Debug, Default)]
pub struct GatewayApiKeyStore {
    keys: Mutex<HashMap<String, GatewayApiKeyRecord>>,
}

#[derive(Debug, Clone)]
struct GatewayApiKeyRecord {
    metadata: GatewayApiKeyMetadata,
    key: String,
}

impl GatewayApiKeyStore {
    pub fn list(&self) -> Vec<GatewayApiKeyMetadata> {
        let mut keys = self
            .lock()
            .values()
            .map(|record| record.metadata.clone())
            .collect::<Vec<_>>();
        keys.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        keys
    }

    pub fn create(&self, label: Option<String>) -> CreatedGatewayApiKey {
        let id = format!("key_{}", uuid::Uuid::new_v4().simple());
        let key = format!(
            "sk-{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let metadata = GatewayApiKeyMetadata {
            id: id.clone(),
            label: label.and_then(clean_label),
            created_at: unix_timestamp(),
            last_used_at: None,
        };
        self.lock().insert(
            id,
            GatewayApiKeyRecord {
                metadata: metadata.clone(),
                key: key.clone(),
            },
        );
        CreatedGatewayApiKey { metadata, key }
    }

    pub fn delete(&self, id: &str) -> bool {
        self.lock().remove(id).is_some()
    }

    pub fn accepts(&self, presented: &str) -> bool {
        let mut records = self.lock();
        if let Some(record) = records.values_mut().find(|record| record.key == presented) {
            record.metadata.last_used_at = Some(unix_timestamp());
            true
        } else {
            false
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, GatewayApiKeyRecord>> {
        self.keys
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn clean_label(label: String) -> Option<String> {
    let label = label.trim();
    (!label.is_empty()).then(|| label.to_owned())
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::GatewayApiKeyStore;

    #[test]
    fn creates_sk_prefixed_key() {
        let created = GatewayApiKeyStore::default().create(Some("test".to_owned()));

        assert!(created.key.starts_with("sk-"));
        assert_eq!(created.metadata.label.as_deref(), Some("test"));
    }

    #[test]
    fn accepts_created_key_and_tracks_last_used() {
        let store = GatewayApiKeyStore::default();
        let created = store.create(None);

        assert!(store.accepts(&created.key));
        assert!(store.list()[0].last_used_at.is_some());
    }
}
