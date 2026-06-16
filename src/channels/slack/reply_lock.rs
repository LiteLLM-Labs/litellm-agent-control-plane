use tokio::sync::OwnedMutexGuard;

use crate::agents::locks::KeyedLockStore;

pub(super) struct SlackPromptLock {
    _guard: OwnedMutexGuard<()>,
}

impl SlackPromptLock {
    pub(super) async fn acquire(locks: &KeyedLockStore, session_id: &str) -> Self {
        Self {
            _guard: locks.lock(&format!("slack_prompt:{session_id}")).await,
        }
    }
}
