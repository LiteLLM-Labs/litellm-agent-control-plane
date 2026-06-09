use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{model_prices::ModelCostMap, sdk::routing::Deployment};

const MAX_BODY_CAPTURE_BYTES: usize = 1_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LoggingStatus {
    Success,
    Error,
}

impl LoggingStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Usage {
    pub total_tokens: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorInformation {
    pub error_type: String,
    pub message: String,
    pub trace: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StandardLoggingPayload {
    pub id: String,
    pub call_type: String,
    pub stream: bool,
    pub status: LoggingStatus,
    pub model: String,
    pub model_id: Option<String>,
    pub model_group: Option<String>,
    pub custom_llm_provider: String,
    pub api_base: String,
    pub start_time: f64,
    pub end_time: f64,
    pub response_time: f64,
    pub response_cost: f64,
    pub usage: Usage,
    pub request: Value,
    pub response: Option<Value>,
    pub metadata: Value,
    pub cache_hit: bool,
    pub cache_key: Option<String>,
    pub request_tags: Value,
    pub end_user: Option<String>,
    pub requester_ip_address: Option<String>,
    pub error_information: Option<ErrorInformation>,
}

impl StandardLoggingPayload {
    pub fn new(
        call_type: &str,
        stream: bool,
        request: Value,
        requested_model: &str,
        deployment: &Deployment,
        headers: &HeaderMap,
    ) -> Self {
        let start_time = now_seconds();
        Self {
            id: request_id(headers),
            call_type: call_type.to_owned(),
            stream,
            status: LoggingStatus::Success,
            model: deployment.upstream_model.clone(),
            model_id: Some(deployment.upstream_model.clone()),
            model_group: Some(requested_model.to_owned()),
            custom_llm_provider: deployment.provider_id.clone(),
            api_base: deployment.api_base.clone(),
            start_time,
            end_time: start_time,
            response_time: 0.0,
            response_cost: 0.0,
            usage: Usage::default(),
            request: sanitize_value(request),
            response: None,
            metadata: json!({ "user_api_key_hash": api_key_hash(headers) }),
            cache_hit: false,
            cache_key: None,
            request_tags: json!([]),
            end_user: None,
            requester_ip_address: header_string(headers, "x-forwarded-for"),
            error_information: None,
        }
    }

    pub fn finish_success(&mut self, response: Value, prices: &ModelCostMap) {
        self.status = LoggingStatus::Success;
        self.response = Some(sanitize_value(response.clone()));
        self.usage = usage_from_response(&response);
        self.response_cost = cost_for_model(&self.model, &self.usage, prices);
        self.finish_time();
    }

    pub fn finish_error(&mut self, error: ErrorInformation) {
        self.status = LoggingStatus::Error;
        self.error_information = Some(error.clone());
        self.metadata = merge_metadata_error(self.metadata.clone(), error);
        self.finish_time();
    }

    fn finish_time(&mut self) {
        self.end_time = now_seconds();
        self.response_time = (self.end_time - self.start_time).max(0.0);
    }
}

pub fn response_value(bytes: &[u8], content_type: Option<&str>) -> Value {
    let body = truncate_bytes(bytes);
    if content_type.unwrap_or_default().contains("json") {
        serde_json::from_slice(&body).unwrap_or_else(|_| json!(String::from_utf8_lossy(&body)))
    } else {
        json!(String::from_utf8_lossy(&body).to_string())
    }
}

pub fn error_information(error_type: &str, message: String) -> ErrorInformation {
    ErrorInformation {
        error_type: error_type.to_owned(),
        message,
        trace: std::backtrace::Backtrace::force_capture().to_string(),
    }
}

fn usage_from_response(response: &Value) -> Usage {
    if let Value::String(text) = response {
        return usage_from_sse(text);
    }
    usage_from_json(response).unwrap_or_default()
}

fn usage_from_sse(text: &str) -> Usage {
    let mut usage = Usage::default();
    for line in text.lines() {
        let Some(data) = line.trim_start().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" || data.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(data) {
            if let Some(next) = usage_from_json(&value) {
                usage = merge_usage(usage, next);
            }
        }
    }
    usage
}

fn usage_from_json(value: &Value) -> Option<Usage> {
    if let Some(usage) = value.get("usage") {
        return Some(usage_from_usage_value(usage));
    }
    match value {
        Value::Array(items) => items.iter().find_map(usage_from_json),
        Value::Object(map) => map.values().find_map(usage_from_json),
        _ => None,
    }
}

fn usage_from_usage_value(usage: &Value) -> Usage {
    let prompt = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let completion = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let total = usage
        .get("total_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(prompt + completion);
    Usage {
        total_tokens: total,
        prompt_tokens: prompt,
        completion_tokens: completion,
    }
}

fn merge_usage(current: Usage, next: Usage) -> Usage {
    Usage {
        total_tokens: next.total_tokens.max(current.total_tokens),
        prompt_tokens: next.prompt_tokens.max(current.prompt_tokens),
        completion_tokens: next.completion_tokens.max(current.completion_tokens),
    }
}

fn cost_for_model(model: &str, usage: &Usage, prices: &ModelCostMap) -> f64 {
    prices
        .get(model)
        .map(|info| {
            usage.prompt_tokens as f64 * info.input_cost_per_token.unwrap_or_default()
                + usage.completion_tokens as f64 * info.output_cost_per_token.unwrap_or_default()
        })
        .unwrap_or_default()
}

fn sanitize_value(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(truncate_string(s)),
        Value::Array(items) => Value::Array(items.into_iter().map(sanitize_value).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(key, _)| key != "secret_fields")
                .map(|(key, value)| (key, sanitize_value(value)))
                .collect(),
        ),
        other => other,
    }
}

fn truncate_string(value: String) -> String {
    if value.len() <= MAX_BODY_CAPTURE_BYTES {
        return value;
    }
    let head: String = value.chars().take(MAX_BODY_CAPTURE_BYTES / 3).collect();
    let tail: String = value
        .chars()
        .rev()
        .take(MAX_BODY_CAPTURE_BYTES / 3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!(
        "{}... (litellm_truncated skipped {} chars) ...{}",
        head,
        value.chars().count().saturating_sub(MAX_BODY_CAPTURE_BYTES),
        tail
    )
}

fn truncate_bytes(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().take(MAX_BODY_CAPTURE_BYTES).copied().collect()
}

fn merge_metadata_error(metadata: Value, error: ErrorInformation) -> Value {
    let mut object = metadata.as_object().cloned().unwrap_or_default();
    object.insert("error_information".to_owned(), json!(error));
    Value::Object(object)
}

fn request_id(headers: &HeaderMap) -> String {
    header_string(headers, "x-request-id")
        .or_else(|| header_string(headers, "x-client-request-id"))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

fn api_key_hash(headers: &HeaderMap) -> Option<String> {
    header_string(headers, "authorization")
        .or_else(|| header_string(headers, "x-api-key"))
        .map(|value| {
            let token = value.strip_prefix("Bearer ").unwrap_or(&value);
            format!("{:x}", Sha256::digest(token.as_bytes()))
        })
}

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn now_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or_default()
}
