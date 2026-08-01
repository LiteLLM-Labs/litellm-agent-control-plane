use std::collections::HashSet;

use serde_json::Value;
use sqlx::PgPool;

use crate::{db::managed_agents::runtime_events, errors::GatewayError, proxy::state::AppState};

use super::runtime_lifecycle::mark_session_status;

pub(super) async fn reconcile_terminal_status_from_events(
    state: &AppState,
    pool: &PgPool,
    session_id: &str,
    current_status: &str,
    events: &Value,
) -> Result<(), GatewayError> {
    let (terminal_status, terminal_error) = terminal_status_from_event_values(events);
    if let Some(status) = terminal_status {
        if current_status != status {
            mark_session_status(state, pool, session_id, status, terminal_error).await?;
        }
    }
    Ok(())
}

pub(super) async fn persist_runtime_event_values(
    pool: &PgPool,
    session_id: &str,
    events: &Value,
) -> Result<(), GatewayError> {
    let Some(items) = event_items(events) else {
        return Ok(());
    };
    for event in items {
        runtime_events::repository::append(pool, session_id, event.clone()).await?;
    }
    Ok(())
}

/// Provider events that are not already in the Postgres cache.
///
/// The list endpoint used to persist and emit *every* event on *every* poll.
/// `append` upserts on (session_id, event_key), so re-persisting an unchanged
/// event is semantically a no-op — but it still costs a transaction, a
/// `SELECT MAX(seq)`, an INSERT and a session touch per event, awaited one at a
/// time, and it re-fires callbacks for history that was already emitted.
///
/// The cache has just been loaded to serve as the provider-unreachable fallback,
/// so filtering against it is free: a repeat poll of an idle session then does no
/// writes and no emissions at all.
pub(super) fn unpersisted_events(stored: &[Value], events: &Value) -> Vec<Value> {
    let Some(items) = event_items(events) else {
        return Vec::new();
    };
    let known: HashSet<String> = stored
        .iter()
        .map(runtime_events::repository::event_key)
        .collect();
    items
        .iter()
        .filter(|event| !known.contains(&runtime_events::repository::event_key(event)))
        .cloned()
        .collect()
}

pub(super) fn event_items(events: &Value) -> Option<&Vec<Value>> {
    events
        .as_array()
        .or_else(|| events.get("data").and_then(Value::as_array))
}

fn terminal_status_from_event_values(events: &Value) -> (Option<&'static str>, Option<String>) {
    let mut terminal_status = None;
    let mut terminal_error = None;
    let Some(items) = event_items(events) else {
        return (None, None);
    };
    for event in items {
        match event.get("type").and_then(Value::as_str) {
            Some("session.status_running") => {
                terminal_status = None;
                terminal_error = None;
            }
            Some("session.status_idle") => {
                terminal_status = Some("idle");
                terminal_error = None;
            }
            Some("session.error") => {
                terminal_status = Some("error");
                terminal_error = Some(event_value_error_message(event));
            }
            _ => {}
        }
    }
    (terminal_status, terminal_error)
}

fn event_value_error_message(event: &Value) -> String {
    event
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .unwrap_or("managed agent interaction failed")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{terminal_status_from_event_values, unpersisted_events};

    #[test]
    fn terminal_status_from_event_list_values() {
        let (status, error) = terminal_status_from_event_values(&json!({
            "data": [{ "type": "session.error", "error": { "message": "boom" } }]
        }));
        assert_eq!(status, Some("error"));
        assert_eq!(error.as_deref(), Some("boom"));

        let (status, error) = terminal_status_from_event_values(&json!([
            { "type": "session.status_running" },
            { "type": "session.status_idle" }
        ]));
        assert_eq!(status, Some("idle"));
        assert_eq!(error, None);
    }

    #[test]
    fn running_event_clears_stale_terminal_status() {
        let (status, error) = terminal_status_from_event_values(&json!([
            { "type": "session.status_idle" },
            { "type": "session.status_running" }
        ]));
        assert_eq!(status, None);
        assert_eq!(error, None);
    }

    #[test]
    fn unpersisted_events_returns_only_uncached_events() {
        let stored = vec![
            json!({ "id": "se_1", "type": "user.message" }),
            json!({ "id": "se_2", "type": "agent.message" }),
        ];
        let provider = json!({ "data": [
            { "id": "se_1", "type": "user.message" },
            { "id": "se_2", "type": "agent.message" },
            { "id": "se_3", "type": "session.status_idle" }
        ]});

        let fresh = unpersisted_events(&stored, &provider);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].get("id").and_then(Value::as_str), Some("se_3"));
    }

    #[test]
    fn unpersisted_events_is_empty_when_cache_is_current() {
        // The common case: polling an idle session must do no writes at all.
        let stored = vec![json!({ "id": "se_1", "type": "agent.message" })];
        let provider = json!({ "data": [{ "id": "se_1", "type": "agent.message" }]});
        assert!(unpersisted_events(&stored, &provider).is_empty());
    }

    #[test]
    fn unpersisted_events_handles_bare_array_and_empty_cache() {
        let provider = json!([{ "id": "se_1" }, { "id": "se_2" }]);
        assert_eq!(unpersisted_events(&[], &provider).len(), 2);
        assert!(unpersisted_events(&[], &json!({})).is_empty());
    }

    #[test]
    fn unpersisted_events_falls_back_to_content_hash_without_an_id() {
        // Events with no `id` are keyed by content hash, matching append().
        let stored = vec![json!({ "type": "agent.message", "text": "a" })];
        let provider = json!({ "data": [
            { "type": "agent.message", "text": "a" },
            { "type": "agent.message", "text": "b" }
        ]});

        let fresh = unpersisted_events(&stored, &provider);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].get("text").and_then(Value::as_str), Some("b"));
    }
}
