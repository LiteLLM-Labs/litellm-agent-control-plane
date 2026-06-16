use serde_json::Value;

use crate::{
    channels::slack::user_ids::{normalize_slack_user_id, INVALID_DM_ALLOWLIST_SENTINEL},
    db::managed_agents::registry::schema::ManagedAgentRow,
    errors::GatewayError,
};

pub(super) fn optional_str<'a>(arguments: &'a Value, field: &str) -> Option<&'a str> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(super) fn allowed_dm_user_ids(arguments: &Value) -> Result<Vec<String>, GatewayError> {
    let values = arguments
        .get("allowed_dm_user_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(
            arguments
                .get("allowed_dm_user_ids")
                .and_then(Value::as_str)
                .into_iter()
                .flat_map(|value| value.split([',', '\n', ' ', '\t'])),
        );
    let mut ids = Vec::new();
    let mut invalid = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let id = match normalize_slack_user_id(value) {
            Some(id) => id,
            None if value == INVALID_DM_ALLOWLIST_SENTINEL => value.to_owned(),
            None => {
                invalid.push(value.to_owned());
                continue;
            }
        };
        if !ids.iter().any(|existing| existing == &id) {
            ids.push(id);
        }
    }
    if invalid.is_empty() {
        Ok(ids)
    } else {
        Err(GatewayError::InvalidJsonMessage(format!(
            "allowed_dm_user_ids must contain Slack user IDs: {}",
            invalid.join(", ")
        )))
    }
}

pub(super) fn child_allowed_dm_user_ids(child: &ManagedAgentRow) -> Vec<String> {
    child
        .config
        .get("slack")
        .and_then(|slack| slack.get("allowed_dm_user_ids"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::allowed_dm_user_ids;
    use crate::channels::slack::user_ids::INVALID_DM_ALLOWLIST_SENTINEL;

    #[test]
    fn allowed_dm_user_ids_normalizes_mentions_and_lowercase_ids() {
        let ids = allowed_dm_user_ids(&json!({
            "allowed_dm_user_ids": ["<@u123>", "W456", "@u123"]
        }))
        .unwrap();

        assert_eq!(ids, vec!["U123", "W456"]);
    }

    #[test]
    fn allowed_dm_user_ids_splits_string_values() {
        let ids = allowed_dm_user_ids(&json!({
            "allowed_dm_user_ids": "<@u123>, w456\nU789"
        }))
        .unwrap();

        assert_eq!(ids, vec!["U123", "W456", "U789"]);
    }

    #[test]
    fn allowed_dm_user_ids_rejects_invalid_tokens() {
        let error = allowed_dm_user_ids(&json!({
            "allowed_dm_user_ids": ["U123", "bob@example.com"]
        }))
        .unwrap_err();

        assert!(error.to_string().contains("bob@example.com"));
    }

    #[test]
    fn allowed_dm_user_ids_preserves_fail_closed_sentinel() {
        let ids = allowed_dm_user_ids(&json!({
            "allowed_dm_user_ids": [INVALID_DM_ALLOWLIST_SENTINEL]
        }))
        .unwrap();

        assert_eq!(ids, vec![INVALID_DM_ALLOWLIST_SENTINEL]);
    }
}
