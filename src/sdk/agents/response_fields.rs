use serde_json::Value;

use super::AgentSdkError;

pub(crate) fn id(raw: &Value) -> Result<String, AgentSdkError> {
    raw.get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(AgentSdkError::MissingId)
}

pub(crate) fn nested_id(raw: &Value, parent: &'static str) -> Result<String, AgentSdkError> {
    raw.get(parent)
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(AgentSdkError::MissingId)
}

pub(crate) fn nested_string_field(
    raw: &Value,
    parent: &'static str,
    field: &'static str,
) -> Result<String, AgentSdkError> {
    raw.get(parent)
        .and_then(|value| value.get(field))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(AgentSdkError::MissingField(field))
}
