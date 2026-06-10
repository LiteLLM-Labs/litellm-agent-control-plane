use std::{collections::HashMap, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use litellm_rust::{
    http::routes::router,
    model_prices::ModelCostMap,
    proxy::{
        config::{GatewayConfig, GeneralSettings, LiteLlmParams, ModelEntry},
        state::AppState,
    },
    sdk::{
        providers::{self, ProviderRegistry},
        routing::Router as ModelRouter,
    },
};
use serde_json::json;
use tower::util::ServiceExt;
use wiremock::{
    matchers::{header as header_match, method, path},
    Mock, MockServer, ResponseTemplate,
};

fn test_config(api_base: String) -> GatewayConfig {
    config_with_models(vec![ModelEntry {
        model_name: "claude".to_owned(),
        litellm_params: LiteLlmParams {
            model: "anthropic/claude-sonnet-4-5".to_owned(),
            api_key: Some("sk-ant-test".to_owned()),
            api_base: Some(api_base),
            extra: Default::default(),
        },
    }])
}

fn config_with_models(model_list: Vec<ModelEntry>) -> GatewayConfig {
    GatewayConfig {
        model_list,
        mcp_servers: Default::default(),
        general_settings: GeneralSettings {
            master_key: Some("sk-local".to_owned()),
            ..Default::default()
        },
        slack: Default::default(),
        agents: Vec::new(),
    }
}

fn test_model_cost_map() -> ModelCostMap {
    serde_json::from_value(json!({
        "claude-sonnet-4-6": {
            "litellm_provider": "anthropic",
            "mode": "chat"
        },
        "claude-3-haiku-20240307": {
            "litellm_provider": "anthropic",
            "mode": "chat"
        },
        "gpt-5.5": {
            "litellm_provider": "openai",
            "mode": "chat"
        }
    }))
    .unwrap()
}

fn wildcard_anthropic_entry(api_key: Option<&str>) -> ModelEntry {
    ModelEntry {
        model_name: "anthropic/*".to_owned(),
        litellm_params: LiteLlmParams {
            model: "anthropic/*".to_owned(),
            api_key: api_key.map(str::to_owned),
            api_base: Some("https://api.anthropic.com".to_owned()),
            extra: Default::default(),
        },
    }
}

fn openai_gpt_entry(api_key: Option<&str>) -> ModelEntry {
    ModelEntry {
        model_name: "gpt-5.5".to_owned(),
        litellm_params: LiteLlmParams {
            model: "openai/gpt-5.5".to_owned(),
            api_key: api_key.map(str::to_owned),
            api_base: Some("https://api.openai.com".to_owned()),
            extra: Default::default(),
        },
    }
}

fn response_model_ids(body: &serde_json::Value) -> Vec<String> {
    body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn forwards_non_streaming_messages() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(header_match("x-api-key", "sk-ant-test"))
        .and(header_match("anthropic-version", "2023-06-01"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-5",
            "content": [{"type": "text", "text": "ok"}],
            "usage": {"input_tokens": 1, "output_tokens": 1}
        })))
        .mount(&upstream)
        .await;

    let config = test_config(upstream.uri());
    let app = router(build_state(&config));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header(header::AUTHORIZATION, "Bearer sk-local")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "model": "claude",
                        "max_tokens": 16,
                        "messages": [{"role": "user", "content": "hi"}]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

fn build_router(config: &GatewayConfig) -> ModelRouter {
    let mut providers = ProviderRegistry::new();
    providers::register_all(&mut providers);
    ModelRouter::from_config(config, &providers).unwrap()
}

fn build_state(config: &GatewayConfig) -> Arc<AppState> {
    build_state_with_model_cost_map(config, HashMap::new())
}

fn build_state_with_model_cost_map(
    config: &GatewayConfig,
    model_cost_map: ModelCostMap,
) -> Arc<AppState> {
    let http = AppState::build_http_client().unwrap();
    Arc::new(
        AppState::new(
            config.clone(),
            build_router(config),
            http,
            model_cost_map,
            None,
        )
        .unwrap(),
    )
}

#[tokio::test]
async fn rejects_missing_master_key() {
    let upstream = MockServer::start().await;
    let config = test_config(upstream.uri());
    let app = router(build_state(&config));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "model": "claude",
                        "max_tokens": 16,
                        "messages": [{"role": "user", "content": "hi"}]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn lists_configured_models_with_openai_shape() {
    let upstream = MockServer::start().await;
    let config = test_config(upstream.uri());
    let app = router(build_state(&config));

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/models")
                .header(header::AUTHORIZATION, "Bearer sk-local")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["object"], "list");
    assert_eq!(body["data"][0]["id"], "claude");
    assert_eq!(body["data"][0]["object"], "model");
    assert_eq!(body["data"][0]["created"], 0);
    assert_eq!(body["data"][0]["owned_by"], "anthropic");
}

#[tokio::test]
async fn expands_wildcard_models_from_model_cost_map() {
    let config = config_with_models(vec![wildcard_anthropic_entry(Some("sk-ant-test"))]);
    let app = router(build_state_with_model_cost_map(
        &config,
        test_model_cost_map(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/models")
                .header(header::AUTHORIZATION, "Bearer sk-local")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["object"], "list");
    assert_eq!(
        response_model_ids(&body),
        vec!["claude-3-haiku-20240307", "claude-sonnet-4-6"]
    );
    assert_eq!(body["data"][0]["owned_by"], "anthropic");
}

#[tokio::test]
async fn lists_exact_models_without_provider_credentials() {
    let config = config_with_models(vec![
        wildcard_anthropic_entry(Some("sk-ant-test")),
        openai_gpt_entry(None),
    ]);
    let app = router(build_state_with_model_cost_map(
        &config,
        test_model_cost_map(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/models")
                .header(header::AUTHORIZATION, "Bearer sk-local")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        response_model_ids(&body),
        vec!["claude-3-haiku-20240307", "claude-sonnet-4-6", "gpt-5.5"]
    );
}

#[tokio::test]
async fn provider_response_includes_configured_model_sources() {
    let config = config_with_models(vec![
        wildcard_anthropic_entry(Some("sk-ant-test")),
        openai_gpt_entry(None),
    ]);
    let app = router(build_state_with_model_cost_map(
        &config,
        test_model_cost_map(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/providers")
                .header(header::AUTHORIZATION, "Bearer sk-local")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let models = body["configured_models"].as_array().unwrap();
    assert_eq!(models.len(), 3);
    assert_eq!(models[0]["id"], "claude-3-haiku-20240307");
    assert_eq!(models[0]["provider_id"], "anthropic");
    assert_eq!(models[0]["source"], "config.yaml");
    assert_eq!(models[0]["configured_model"], "anthropic/*");
    assert_eq!(models[0]["source_detail"], "expanded from anthropic/*");
    assert_eq!(models[2]["id"], "gpt-5.5");
    assert_eq!(models[2]["provider_id"], "openai");
    assert_eq!(models[2]["source"], "config.yaml");
    assert_eq!(models[2]["source_detail"], "model_list entry");
}

#[tokio::test]
async fn rejects_runtime_models_without_database() {
    let upstream = MockServer::start().await;
    let config = test_config(upstream.uri());
    let app = router(build_state(&config));

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/models?runtime=cursor")
                .header(header::AUTHORIZATION, "Bearer sk-local")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["error"]["message"], "database is not configured");
}

#[tokio::test]
async fn rejects_unknown_runtime_models_without_database() {
    let upstream = MockServer::start().await;
    let config = test_config(upstream.uri());
    let app = router(build_state(&config));

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/models?runtime=unknown")
                .header(header::AUTHORIZATION, "Bearer sk-local")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        body["error"]["message"],
        "invalid request json: unsupported runtime: unknown"
    );
}

#[tokio::test]
async fn forwards_streaming_messages_as_sse() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string("event: message_start\ndata: {\"type\":\"message_start\"}\n\n"),
        )
        .mount(&upstream)
        .await;

    let config = test_config(upstream.uri());
    let app = router(build_state(&config));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header(header::AUTHORIZATION, "Bearer sk-local")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "model": "claude",
                        "max_tokens": 16,
                        "stream": true,
                        "messages": [{"role": "user", "content": "hi"}]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/event-stream"
    );
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert!(std::str::from_utf8(&body)
        .unwrap()
        .contains("message_start"));
}
