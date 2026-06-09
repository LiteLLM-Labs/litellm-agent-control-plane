use axum::http::{HeaderMap, HeaderValue};
use litellm_rust::{
    callbacks::standard_logging::{error_information, StandardLoggingPayload},
    proxy::config::GeneralSettings,
    sdk::routing::Deployment,
};
use serde_json::json;
use std::collections::HashMap;

fn deployment() -> Deployment {
    Deployment {
        provider_id: "anthropic".to_owned(),
        upstream_model: "claude-test".to_owned(),
        api_base: "http://localhost:9999".to_owned(),
        api_key: "sk-test".to_owned(),
    }
}

#[test]
fn standard_logging_payload_records_success_and_error_metadata() {
    let mut headers = HeaderMap::new();
    headers.insert("authorization", HeaderValue::from_static("Bearer sk-local"));
    headers.insert("x-request-id", HeaderValue::from_static("req-test"));
    let request = json!({"model": "claude", "messages": [{"role": "user", "content": "hi"}]});
    let mut payload = StandardLoggingPayload::new(
        "messages",
        false,
        request,
        "claude",
        &deployment(),
        &headers,
    );

    payload.finish_success(
        json!({"content": [{"type": "text", "text": "ok"}], "usage": {"input_tokens": 3, "output_tokens": 2}}),
        &HashMap::new(),
    );

    assert_eq!(payload.id, "req-test");
    assert_eq!(payload.usage.total_tokens, 5);
    assert_eq!(payload.response_cost, 0.0);

    payload.finish_error(error_information(
        "upstream_http_error",
        "HTTP 400".to_owned(),
    ));
    assert_eq!(payload.status.as_str(), "error");
    assert!(payload.metadata.get("error_information").is_some());
}

#[test]
fn spend_log_batch_defaults_match_litellm_style_config() {
    let settings = GeneralSettings::default();

    assert!(!settings.store_prompts_in_spend_logs);
    assert_eq!(settings.spend_logs_batch_interval_seconds, 10);
    assert_eq!(settings.spend_logs_batch_size, 100);
    assert_eq!(settings.spend_logs_queue_capacity, 10_000);
}
