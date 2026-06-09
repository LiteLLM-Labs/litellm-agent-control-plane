use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex, MutexGuard},
};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

pub struct KeyedLockStore {
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

impl KeyedLockStore {
    pub async fn lock(&self, key: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks();
            locks
                .entry(key.to_owned())
                .or_insert_with(|| Arc::new(AsyncMutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }

    fn locks(&self) -> MutexGuard<'_, HashMap<String, Arc<AsyncMutex<()>>>> {
        self.locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Default for KeyedLockStore {
    fn default() -> Self {
        Self {
            locks: Mutex::new(HashMap::new()),
        }
    }
}

impl fmt::Debug for KeyedLockStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeyedLockStore")
            .finish_non_exhaustive()
    }
}
