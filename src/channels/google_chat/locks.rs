use tokio::sync::OwnedMutexGuard;

use crate::agents::locks::KeyedLockStore;

pub(super) struct GoogleChatConversationLock {
    _guard: OwnedMutexGuard<()>,
}

impl GoogleChatConversationLock {
    pub(super) async fn acquire(
        locks: &KeyedLockStore,
        agent_id: &str,
        conversation_key: &str,
    ) -> Self {
        Self {
            _guard: locks
                .lock(&format!(
                    "google_chat_conversation:{agent_id}:{conversation_key}"
                ))
                .await,
        }
    }
}

pub(super) struct GoogleChatPromptLock {
    _guard: OwnedMutexGuard<()>,
}

impl GoogleChatPromptLock {
    pub(super) async fn acquire(locks: &KeyedLockStore, session_id: &str) -> Self {
        Self {
            _guard: locks
                .lock(&format!("google_chat_prompt:{session_id}"))
                .await,
        }
    }
}
