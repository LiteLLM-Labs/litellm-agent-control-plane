use std::collections::HashSet;

use serde_json::Value;

pub(super) fn filter_allowed_tools(tools: Vec<Value>, allowed_tools: &Value) -> Vec<Value> {
    let allowed = allowed_tool_names(allowed_tools);
    if allowed.is_empty() {
        return tools;
    }
    tools
        .into_iter()
        .filter(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| allowed.contains(name))
        })
        .collect()
}

fn allowed_tool_names(value: &Value) -> HashSet<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}
