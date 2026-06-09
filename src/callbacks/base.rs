use std::{future::Future, pin::Pin};

use crate::callbacks::{events::CallbackEventPayload, standard_logging::StandardLoggingPayload};

pub trait BaseCallback: Send + Sync + 'static {
    fn on_success(&self, payload: StandardLoggingPayload);
    fn on_error(&self, payload: StandardLoggingPayload);
    fn on_event<'a>(
        &'a self,
        _payload: CallbackEventPayload,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async {})
    }
}
