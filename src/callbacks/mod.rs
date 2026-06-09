pub mod base;
pub mod events;
pub mod litellm_db;
pub mod standard_logging;

use std::sync::Arc;

use base::BaseCallback;
use events::CallbackEventPayload;
use standard_logging::StandardLoggingPayload;

#[derive(Clone, Default)]
pub struct CallbackManager {
    callbacks: Arc<Vec<Arc<dyn BaseCallback>>>,
}

impl CallbackManager {
    pub fn new(callbacks: Vec<Arc<dyn BaseCallback>>) -> Self {
        Self {
            callbacks: Arc::new(callbacks),
        }
    }

    pub fn on_success(&self, payload: StandardLoggingPayload) {
        for callback in self.callbacks.iter() {
            callback.on_success(payload.clone());
        }
    }

    pub fn on_error(&self, payload: StandardLoggingPayload) {
        for callback in self.callbacks.iter() {
            callback.on_error(payload.clone());
        }
    }

    pub async fn on_event(&self, payload: CallbackEventPayload) {
        for callback in self.callbacks.iter() {
            callback.on_event(payload.clone()).await;
        }
    }
}

impl std::fmt::Debug for CallbackManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CallbackManager")
            .field("callback_count", &self.callbacks.len())
            .finish()
    }
}
