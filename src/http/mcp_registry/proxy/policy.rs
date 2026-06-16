use std::collections::HashSet;

use axum::{
    body::Body,
    http::{header::CONTENT_TYPE, HeaderValue, StatusCode},
    response::Response,
};
use serde_json::{json, Value};

#[derive(Debug, Default)]
pub(super) struct McpRequest {
    entries: Vec<McpRequestEntry>,
    is_batch: bool,
    invalid_json: bool,
}

#[derive(Debug)]
struct McpRequestEntry {
    id: Option<Value>,
    method: Option<String>,
    is_tool_call: bool,
    tool_name: Option<String>,
}

pub(super) fn parse_mcp_request(body: &[u8]) -> McpRequest {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return McpRequest {
            invalid_json: !body.is_empty(),
            ..McpRequest::default()
        };
    };
    if let Some(obj) = value.as_object() {
        return McpRequest {
            entries: vec![request_entry(obj)],
            is_batch: false,
            invalid_json: false,
        };
    }
    let entries = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(request_entry)
        .collect();
    McpRequest {
        entries,
        is_batch: value.is_array(),
        invalid_json: false,
    }
}

fn request_entry(obj: &serde_json::Map<String, Value>) -> McpRequestEntry {
    let method = obj.get("method").and_then(Value::as_str).map(str::to_owned);
    let is_tool_call = method.as_deref() == Some("tools/call");
    let tool_name = is_tool_call
        .then(|| {
            obj.get("params")
                .and_then(|params| params.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .flatten();
    McpRequestEntry {
        id: obj.get("id").cloned(),
        method,
        is_tool_call,
        tool_name,
    }
}

pub(super) fn allowed_tools(value: &Value) -> HashSet<String> {
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

pub(super) fn reject_disallowed_call(
    request: &McpRequest,
    allowed_tools: &HashSet<String>,
) -> Option<Response> {
    if request.invalid_json && !allowed_tools.is_empty() {
        return Some(mcp_error_response(None, "Invalid MCP request"));
    }
    let entry = request
        .entries
        .iter()
        .find(|entry| entry_has_disallowed_tool(entry, allowed_tools))?;
    Some(if request.is_batch {
        mcp_batch_error_response(request, "Tool is not allowed for this MCP server")
    } else {
        mcp_error_response(entry.id.clone(), "Tool is not allowed for this MCP server")
    })
}

pub(super) fn should_filter_tools_list(
    request: &McpRequest,
    status: StatusCode,
    allowed_tools: &HashSet<String>,
) -> bool {
    request
        .entries
        .iter()
        .any(|entry| entry.method.as_deref() == Some("tools/list"))
        && status.is_success()
        && !allowed_tools.is_empty()
}

pub(super) fn filter_tools_list_payload(
    text: &str,
    content_type: &str,
    allowed_tools: &HashSet<String>,
) -> String {
    if content_type.contains("event-stream") || text.starts_with("data:") {
        return filter_event_stream_tools(text, allowed_tools);
    }
    let Ok(mut value) = serde_json::from_str::<Value>(text) else {
        return text.to_owned();
    };
    filter_tools_in_value(&mut value, allowed_tools);
    value.to_string()
}

fn filter_event_stream_tools(text: &str, allowed_tools: &HashSet<String>) -> String {
    text.lines()
        .map(|line| {
            let Some(data) = line.strip_prefix("data:") else {
                return line.to_owned();
            };
            let Ok(mut value) = serde_json::from_str::<Value>(data.trim()) else {
                return line.to_owned();
            };
            filter_tools_in_value(&mut value, allowed_tools);
            format!("data: {value}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn filter_tools_in_value(value: &mut Value, allowed_tools: &HashSet<String>) {
    if let Some(items) = value.as_array_mut() {
        for item in items {
            filter_tools_in_value(item, allowed_tools);
        }
        return;
    }
    if let Some(tools) = value
        .pointer_mut("/result/tools")
        .and_then(Value::as_array_mut)
    {
        retain_allowed_tools(tools, allowed_tools);
    }
    if let Some(tools) = value.get_mut("tools").and_then(Value::as_array_mut) {
        retain_allowed_tools(tools, allowed_tools);
    }
}

fn retain_allowed_tools(tools: &mut Vec<Value>, allowed_tools: &HashSet<String>) {
    tools.retain(|tool| {
        tool.get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| tool_is_allowed(name, allowed_tools))
    });
}

fn tool_is_allowed(tool_name: &str, allowed_tools: &HashSet<String>) -> bool {
    allowed_tools.is_empty() || allowed_tools.contains(tool_name)
}

fn entry_has_disallowed_tool(entry: &McpRequestEntry, allowed_tools: &HashSet<String>) -> bool {
    if !entry.is_tool_call {
        return false;
    }
    entry
        .tool_name
        .as_deref()
        .map(|tool_name| !tool_is_allowed(tool_name, allowed_tools))
        .unwrap_or(!allowed_tools.is_empty())
}

fn mcp_error_value(id: Option<Value>, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": {
            "code": -32602,
            "message": message,
        },
    })
}

fn mcp_error_response(id: Option<Value>, message: &str) -> Response {
    response_with_json(mcp_error_value(id, message))
}

fn mcp_batch_error_response(request: &McpRequest, message: &str) -> Response {
    let mut errors = request
        .entries
        .iter()
        .filter_map(|entry| entry.id.clone())
        .map(|id| mcp_error_value(Some(id), message))
        .collect::<Vec<_>>();
    if errors.is_empty() {
        errors.push(mcp_error_value(None, message));
    }
    response_with_json(Value::Array(errors))
}

fn response_with_json(body: Value) -> Response {
    let mut response = Response::new(Body::from(body.to_string()));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn batch_request_rejects_disallowed_tool_call() {
        let body = br#"[
            {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"safe_tool"}},
            {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_email"}}
        ]"#;
        let request = parse_mcp_request(body);
        let allowed_tools = HashSet::from(["safe_tool".to_owned()]);

        let response = reject_disallowed_call(&request, &allowed_tools)
            .expect("disallowed batch call should be rejected");
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        let value = serde_json::from_slice::<Value>(&body).unwrap();

        assert_eq!(value.as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn missing_tool_name_is_rejected_when_allowlist_exists() {
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}"#;
        let request = parse_mcp_request(body);
        let allowed_tools = HashSet::from(["safe_tool".to_owned()]);

        assert!(reject_disallowed_call(&request, &allowed_tools).is_some());
    }

    #[test]
    fn invalid_json_is_rejected_when_allowlist_exists() {
        let request = parse_mcp_request(b"{");
        let allowed_tools = HashSet::from(["safe_tool".to_owned()]);

        assert!(reject_disallowed_call(&request, &allowed_tools).is_some());
    }

    #[test]
    fn batch_tools_list_payload_is_filtered() {
        let body = r#"[
            {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"safe_tool"},{"name":"send_email"}]}}
        ]"#;
        let allowed_tools = HashSet::from(["safe_tool".to_owned()]);

        let filtered = filter_tools_list_payload(body, "application/json", &allowed_tools);

        assert!(filtered.contains("safe_tool"));
        assert!(!filtered.contains("send_email"));
    }
}
