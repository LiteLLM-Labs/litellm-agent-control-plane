use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::managed_agents::now_ms;

pub const MANAGED_RUNTIME_SESSION_EVENT: &str = "managed_agent.runtime_event";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallbackEventPayload {
    pub id: String,
    pub event: String,
    pub session_id: Option<String>,
    pub properties: Value,
    pub created_at: i64,
}

impl CallbackEventPayload {
    pub fn managed_runtime_session_event<T: Serialize>(
        session_id: &str,
        event: &T,
    ) -> Option<Self> {
        let event_json = serde_json::to_value(event).ok()?;
        Some(Self {
            id: callback_event_id(&event_json),
            event: MANAGED_RUNTIME_SESSION_EVENT.to_owned(),
            session_id: Some(session_id.to_owned()),
            properties: json!({ "runtime_event": event_json }),
            created_at: now_ms(),
        })
    }

    pub fn runtime_event(&self) -> Option<Value> {
        self.properties.get("runtime_event").cloned()
    }
}

fn callback_event_id(event: &Value) -> String {
    event
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| crate::db::managed_agents::id("cbevt"))
}
