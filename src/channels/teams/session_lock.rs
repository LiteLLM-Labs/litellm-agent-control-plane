use tokio::sync::OwnedMutexGuard;

use crate::agents::locks::KeyedLockStore;

pub(super) struct TeamsConversationLock {
    _guard: OwnedMutexGuard<()>,
}

impl TeamsConversationLock {
    pub(super) async fn acquire(
        locks: &KeyedLockStore,
        agent_id: &str,
        conversation_id: &str,
    ) -> Self {
        Self {
            _guard: locks
                .lock(&format!("teams_conversation:{agent_id}:{conversation_id}"))
                .await,
        }
    }
}
