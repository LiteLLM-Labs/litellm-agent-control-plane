use tokio::sync::OwnedMutexGuard;

use crate::agents::locks::KeyedLockStore;

pub(super) struct TeamsPromptLock {
    _guard: OwnedMutexGuard<()>,
}

impl TeamsPromptLock {
    pub(super) async fn acquire(locks: &KeyedLockStore, session_id: &str) -> Self {
        Self {
            _guard: locks.lock(&format!("teams_prompt:{session_id}")).await,
        }
    }
}
