use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use serde_json::{json, Value};

use crate::{
    errors::GatewayError,
    sdk::{
        routing::Deployment,
        providers::base::openai_responses::BaseOpenAiResponsesTransformation,
        providers::base::{ProviderRequest, Transformation},
    },
};

// Headers Codex attaches to each turn. Forwarded so upstream logging/analytics
// keep request correlation; harmless to OpenAI if it ignores them.
const FORWARDED_HEADERS: &[&str] = &[
    "accept",
    "originator",
    "session-id",
    "thread-id",
    "x-client-request-id",
    "x-codex-beta-features",
    "x-codex-turn-metadata",
    "x-codex-window-id",
];

#[derive(Debug, Default, Clone)]
pub struct OpenAiResponsesTransformation;

impl BaseOpenAiResponsesTransformation for OpenAiResponsesTransformation {
    fn supports_native_file_search(&self) -> bool {
        true
    }

    fn supports_native_websocket(&self) -> bool {
        true
    }

    fn validate_environment(
        &self,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<HeaderMap, GatewayError> {
        let mut headers = HeaderMap::new();
        let bearer = format!("Bearer {}", deployment.api_key);
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&bearer)
                .map_err(|_| GatewayError::InvalidConfig("invalid api_key".to_owned()))?,
        );
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        for name in FORWARDED_HEADERS {
            if let Some(value) = inbound_headers.get(*name) {
                if let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) {
                    headers.insert(header_name, value.clone());
                }
            }
        }

        Ok(headers)
    }
}

impl Transformation for OpenAiResponsesTransformation {
    fn transform_request(
        &self,
        body: Value,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<ProviderRequest, GatewayError> {
        self.transform_openai_responses_request(body, deployment, inbound_headers)
    }

    fn transform_response_headers(&self, upstream: &HeaderMap, stream: bool) -> HeaderMap {
        self.transform_openai_responses_response_headers(upstream, stream)
    }

    fn messages_url(&self, deployment: &Deployment) -> String {
        deployment.responses_url()
    }

    fn transform_messages_request(
        &self,
        body: Value,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<ProviderRequest, GatewayError> {
        self.transform_openai_responses_request(
            anthropic_messages_to_openai_responses(body, deployment),
            deployment,
            inbound_headers,
        )
    }

    fn transform_messages_response_headers(&self, upstream: &HeaderMap, stream: bool) -> HeaderMap {
        self.transform_openai_responses_response_headers(upstream, stream)
    }

    fn transforms_messages_response_body(&self) -> bool {
        true
    }

    fn transform_messages_response_body(
        &self,
        body: Vec<u8>,
        status: StatusCode,
        stream: bool,
        deployment: &Deployment,
        content_type: Option<&str>,
    ) -> Result<Vec<u8>, GatewayError> {
        if !status.is_success() {
            return Ok(body);
        }
        if stream {
            return Ok(openai_response_to_anthropic_sse(&body, content_type, deployment)?.into_bytes());
        }
        let raw: Value = serde_json::from_slice(&body)?;
        Ok(serde_json::to_vec(&openai_response_to_anthropic_message(
            &raw, deployment,
        ))?)
    }
}

fn anthropic_messages_to_openai_responses(body: Value, deployment: &Deployment) -> Value {
    let mut request = serde_json::Map::new();
    request.insert(
        "model".to_owned(),
        Value::String(deployment.upstream_model.clone()),
    );
    request.insert("input".to_owned(), anthropic_input(&body));
    if let Some(max_tokens) = body.get("max_tokens").cloned() {
        request.insert("max_output_tokens".to_owned(), max_tokens);
    }
    for key in ["stream", "temperature", "top_p"] {
        if let Some(value) = body.get(key).cloned() {
            request.insert(key.to_owned(), value);
        }
    }
    if let Some(stop) = body
        .get("stop_sequences")
        .cloned()
        .or_else(|| body.get("stop").cloned())
    {
        request.insert("stop".to_owned(), stop);
    }
    Value::Object(request)
}

fn anthropic_input(body: &Value) -> Value {
    let mut input = Vec::new();
    if let Some(system) = body.get("system") {
        let text = anthropic_content_text(system);
        if !text.is_empty() {
            input.push(json!({ "role": "system", "content": text }));
        }
    }
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for message in messages {
            let Some(role) = message.get("role").and_then(Value::as_str) else {
                continue;
            };
            let text = anthropic_content_text(message.get("content").unwrap_or(&Value::Null));
            if !text.is_empty() {
                input.push(json!({ "role": role, "content": text }));
            }
        }
    }
    if input.is_empty() {
        return Value::String(String::new());
    }
    Value::Array(input)
}

fn anthropic_content_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text.as_str()),
                Value::Object(map) => map.get("text").and_then(Value::as_str),
                _ => None,
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => map
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        _ => String::new(),
    }
}

fn openai_response_to_anthropic_message(raw: &Value, deployment: &Deployment) -> Value {
    let (input_tokens, output_tokens) = openai_usage(raw);
    json!({
        "id": raw.get("id").and_then(Value::as_str).unwrap_or("msg_openai_response"),
        "type": "message",
        "role": "assistant",
        "model": raw
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(deployment.upstream_model.as_str()),
        "content": [{
            "type": "text",
            "text": openai_output_text(raw)
        }],
        "stop_reason": "end_turn",
        "stop_sequence": null,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens
        }
    })
}

fn openai_response_to_anthropic_sse(
    body: &[u8],
    content_type: Option<&str>,
    deployment: &Deployment,
) -> Result<String, GatewayError> {
    let parsed = if content_type.unwrap_or_default().contains("text/event-stream") || looks_like_sse(body) {
        parse_openai_sse(body)
    } else {
        let raw: Value = serde_json::from_slice(body)?;
        ParsedOpenAiStream {
            text: openai_output_text(&raw),
            response: raw,
        }
    };
    let (input_tokens, output_tokens) = openai_usage(&parsed.response);
    let message_id = parsed
        .response
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("msg_openai_response");
    let model = parsed
        .response
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(deployment.upstream_model.as_str());
    let mut out = String::new();
    push_sse(
        &mut out,
        "message_start",
        json!({
            "type": "message_start",
            "message": {
                "id": message_id,
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": null,
                "stop_sequence": null,
                "usage": {
                    "input_tokens": input_tokens,
                    "output_tokens": 0
                }
            }
        }),
    );
    push_sse(
        &mut out,
        "content_block_start",
        json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": {
                "type": "text",
                "text": ""
            }
        }),
    );
    if !parsed.text.is_empty() {
        push_sse(
            &mut out,
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "text_delta",
                    "text": parsed.text
                }
            }),
        );
    }
    push_sse(
        &mut out,
        "content_block_stop",
        json!({
            "type": "content_block_stop",
            "index": 0
        }),
    );
    push_sse(
        &mut out,
        "message_delta",
        json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": "end_turn",
                "stop_sequence": null
            },
            "usage": {
                "output_tokens": output_tokens
            }
        }),
    );
    push_sse(&mut out, "message_stop", json!({ "type": "message_stop" }));
    Ok(out)
}

#[derive(Debug)]
struct ParsedOpenAiStream {
    text: String,
    response: Value,
}

fn looks_like_sse(body: &[u8]) -> bool {
    String::from_utf8_lossy(body)
        .lines()
        .any(|line| line.trim_start().starts_with("data:"))
}

fn parse_openai_sse(body: &[u8]) -> ParsedOpenAiStream {
    let mut text = String::new();
    let mut response = Value::Null;
    for line in String::from_utf8_lossy(body).lines() {
        let Some(data) = line.trim_start().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    text.push_str(delta);
                }
            }
            Some("response.output_text.done") => {
                if text.is_empty() {
                    if let Some(done_text) = value.get("text").and_then(Value::as_str) {
                        text.push_str(done_text);
                    }
                }
            }
            Some("response.completed") => {
                response = value.get("response").cloned().unwrap_or(Value::Null);
            }
            _ => {}
        }
    }
    if text.is_empty() && !response.is_null() {
        text = openai_output_text(&response);
    }
    ParsedOpenAiStream { text, response }
}

fn push_sse(out: &mut String, event: &str, data: Value) {
    out.push_str("event: ");
    out.push_str(event);
    out.push_str("\ndata: ");
    out.push_str(&data.to_string());
    out.push_str("\n\n");
}

fn openai_output_text(value: &Value) -> String {
    if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        return text.to_owned();
    }
    let mut parts = Vec::new();
    if let Some(output) = value.get("output") {
        collect_output_text(output, &mut parts);
    }
    parts.join("")
}

fn collect_output_text(value: &Value, parts: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_output_text(item, parts);
            }
        }
        Value::Object(map) => {
            let text_type = map.get("type").and_then(Value::as_str);
            if matches!(text_type, Some("output_text" | "text")) {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
                    parts.push(text.to_owned());
                    return;
                }
            }
            for key in ["content", "output"] {
                if let Some(child) = map.get(key) {
                    collect_output_text(child, parts);
                }
            }
        }
        _ => {}
    }
}

fn openai_usage(value: &Value) -> (i64, i64) {
    let usage = value.get("usage").unwrap_or(&Value::Null);
    let input = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let output = usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    (input, output)
}

#[cfg(test)]
mod tests {
    use axum::http::{header, HeaderMap, HeaderValue};
    use serde_json::json;

    use super::OpenAiResponsesTransformation;
    use crate::sdk::{
        providers::base::{
            openai_responses::BaseOpenAiResponsesTransformation, Transformation,
        },
        routing::Deployment,
    };

    fn deployment() -> Deployment {
        Deployment {
            provider_id: "openai".to_owned(),
            upstream_model: "gpt-5.5".to_owned(),
            api_base: "https://api.openai.com".to_owned(),
            api_key: "sk-upstream".to_owned(),
        }
    }

    #[test]
    fn rewrites_model_and_sets_bearer_auth() {
        let req = OpenAiResponsesTransformation
            .transform_request(
                json!({ "model": "gpt-codex", "input": [] }),
                &deployment(),
                &HeaderMap::new(),
            )
            .unwrap();

        let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["model"], "gpt-5.5");
        assert_eq!(
            req.headers.get(header::AUTHORIZATION).unwrap(),
            "Bearer sk-upstream"
        );
        assert!(!req.stream);
    }

    #[test]
    fn detects_stream_flag() {
        let req = OpenAiResponsesTransformation
            .transform_request(
                json!({ "model": "gpt-5.5", "stream": true }),
                &deployment(),
                &HeaderMap::new(),
            )
            .unwrap();
        assert!(req.stream);
    }

    #[test]
    fn forwards_codex_headers() {
        let mut inbound = HeaderMap::new();
        inbound.insert("originator", HeaderValue::from_static("codex_exec"));
        inbound.insert("session-id", HeaderValue::from_static("abc"));

        let req = OpenAiResponsesTransformation
            .transform_request(json!({ "model": "gpt-5.5" }), &deployment(), &inbound)
            .unwrap();

        assert_eq!(req.headers.get("originator").unwrap(), "codex_exec");
        assert_eq!(req.headers.get("session-id").unwrap(), "abc");
    }

    #[test]
    fn streaming_response_is_event_stream() {
        let headers =
            OpenAiResponsesTransformation.transform_response_headers(&HeaderMap::new(), true);
        assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "text/event-stream");
    }

    #[test]
    fn strips_custom_tool_namespace_in_base_responses_transform() {
        let req = OpenAiResponsesTransformation
            .transform_request(
                json!({
                    "model": "gpt-5.5",
                    "input": [
                        {
                            "type": "custom_tool_call",
                            "name": "tool",
                            "namespace": "internal"
                        }
                    ]
                }),
                &deployment(),
                &HeaderMap::new(),
            )
            .unwrap();

        let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        assert!(body["input"][0].get("namespace").is_none());
    }

    #[test]
    fn declares_native_responses_capabilities() {
        assert!(OpenAiResponsesTransformation.supports_native_file_search());
        assert!(OpenAiResponsesTransformation.supports_native_websocket());
    }
}
