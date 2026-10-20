#[path = "minimax_catalog/history.rs"]
mod history;

use history::{messages_history, responses_history};
use std::{collections::HashMap, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    Router,
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
use serde_json::{json, Value};
use tower::util::ServiceExt;
use wiremock::{
    matchers::{body_json, header as header_match, method, path},
    Mock, MockServer, ResponseTemplate,
};

fn model_entry(alias: &str, model: &str, api_base: &str) -> ModelEntry {
    ModelEntry {
        model_name: alias.to_owned(),
        litellm_params: LiteLlmParams {
            model: format!("minimax/{model}"),
            api_key: Some("test-minimax".to_owned()),
            api_base: Some(api_base.to_owned()),
            extra: Default::default(),
        },
    }
}

fn app(entries: Vec<ModelEntry>, cost_map: ModelCostMap) -> Router {
    let config = GatewayConfig {
        model_list: entries,
        mcp_servers: Default::default(),
        general_settings: GeneralSettings {
            master_key: Some("test-local".to_owned()),
            ..Default::default()
        },
        slack: Default::default(),
        agents: Vec::new(),
    };
    let mut providers = ProviderRegistry::new();
    providers::register_all(&mut providers);
    let routes = ModelRouter::from_config(&config, &providers).unwrap();
    router(Arc::new(
        AppState::new(
            config,
            routes,
            AppState::build_http_client().unwrap(),
            cost_map,
            None,
        )
        .unwrap(),
    ))
}

fn request(uri: &str, payload: Option<Value>) -> Request<Body> {
    Request::builder()
        .method(if payload.is_some() { "POST" } else { "GET" })
        .uri(uri)
        .header(header::AUTHORIZATION, "Bearer test-local")
        .header(header::CONTENT_TYPE, "application/json")
        .body(payload.map_or_else(Body::empty, |value| Body::from(value.to_string())))
        .unwrap()
}

#[tokio::test]
async fn wildcard_catalog_prefers_flash_without_removing_explicit_or_media_models() {
    let cost_map = serde_json::from_value(json!({
        "minimax/MiniMax-M2.7": {"litellm_provider": "minimax", "mode": "chat"},
        "minimax/MiniMax-M3": {"litellm_provider": "minimax", "mode": "chat"},
        "minimax/speech-02-hd": {"litellm_provider": "minimax", "mode": "audio_speech"},
        "unrelated": {"litellm_provider": "other", "mode": "chat"}
    }))
    .unwrap();
    let app = app(
        vec![
            model_entry("minimax/*", "*", "https://api.minimax.io/anthropic"),
            model_entry(
                "saved-legacy",
                "MiniMax-M2.7",
                "https://api.minimax.io/anthropic",
            ),
            model_entry(
                "custom-alias",
                "custom-model",
                "https://custom.example/anthropic",
            ),
        ],
        cost_map,
    );
    let response = app.oneshot(request("/v1/models", None)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    let ids: Vec<_> = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| model["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![
            "minimax/MiniMax-M3.1-Flash",
            "minimax/MiniMax-M3",
            "minimax/speech-02-hd",
            "saved-legacy",
            "custom-alias",
        ]
    );
}

#[tokio::test]
async fn discovered_default_reaches_both_http_protocols() {
    for (endpoint, upstream_path, payload) in [
        (
            "/v1/messages",
            "/anthropic/v1/messages",
            json!({
                "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]
            }),
        ),
        (
            "/v1/responses",
            "/v1/responses",
            json!({"input": "hi", "max_output_tokens": 16}),
        ),
    ] {
        let upstream = MockServer::start().await;
        let app = app(
            vec![model_entry("minimax/*", "*", &upstream.uri())],
            HashMap::new(),
        );
        let response = app
            .clone()
            .oneshot(request("/v1/models", None))
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let models: Value = serde_json::from_slice(&body).unwrap();
        let mut inbound = payload;
        inbound["model"] = models["data"][0]["id"].clone();
        assert_eq!(inbound["model"], "minimax/MiniMax-M3.1-Flash");
        let mut expected = inbound.clone();
        expected["model"] = json!("MiniMax-M3.1-Flash");
        assert_forwarded(
            app,
            &upstream,
            endpoint,
            upstream_path,
            inbound,
            expected,
            false,
        )
        .await;
    }
}

async fn assert_forwarded(
    app: Router,
    upstream: &MockServer,
    endpoint: &str,
    upstream_path: &str,
    inbound: Value,
    expected: Value,
    stream: bool,
) {
    let (auth_header, auth_value) = if endpoint == "/v1/messages" {
        ("x-api-key", "test-minimax")
    } else {
        ("authorization", "Bearer test-minimax")
    };
    let response = if stream {
        ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_string("data: {\"preserved\":true}\n\n")
    } else {
        ResponseTemplate::new(200).set_body_json(json!({"id": "test", "content": [], "output": []}))
    };
    Mock::given(method("POST"))
        .and(path(upstream_path))
        .and(header_match(auth_header, auth_value))
        .and(body_json(expected))
        .respond_with(response)
        .expect(1)
        .mount(upstream)
        .await;
    let response = app.oneshot(request(endpoint, Some(inbound))).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    if stream {
        assert_eq!(body.as_ref(), b"data: {\"preserved\":true}\n\n");
    }
    upstream.verify().await;
}

#[tokio::test]
async fn explicit_models_preserve_messages_history_media_and_effort() {
    for model in [
        "MiniMax-M3.1-Flash",
        "MiniMax-M3",
        "MiniMax-M2.7",
        "custom-model",
    ] {
        for suffix in ["/v1", "/anthropic", "/custom/anthropic"] {
            let upstream = MockServer::start().await;
            let base = format!("{}{suffix}", upstream.uri());
            let app = app(
                vec![model_entry("saved-alias", model, &base)],
                HashMap::new(),
            );
            let inbound = json!({
                "model": "saved-alias", "max_tokens": 32, "stream": true,
                "thinking": {"type": "adaptive"}, "output_config": {"effort": "high"},
                "messages": messages_history(),
                "tools": [{"name": "lookup", "input_schema": {"type": "object"}}]
            });
            let mut expected = inbound.clone();
            expected["model"] = json!(model);
            let path = if suffix.starts_with("/custom") {
                "/custom/anthropic/v1/messages"
            } else {
                "/anthropic/v1/messages"
            };
            assert_forwarded(
                app,
                &upstream,
                "/v1/messages",
                path,
                inbound,
                expected,
                true,
            )
            .await;
        }
    }
}

#[tokio::test]
async fn explicit_models_preserve_responses_history_media_and_effort() {
    for model in [
        "MiniMax-M3.1-Flash",
        "MiniMax-M3",
        "MiniMax-M2.7",
        "custom-model",
    ] {
        for effort in [
            None,
            Some("low"),
            Some("medium"),
            Some("high"),
            Some("xhigh"),
            Some("max"),
        ] {
            let upstream = MockServer::start().await;
            let base = format!("{}/anthropic", upstream.uri());
            let app = app(
                vec![model_entry("saved-alias", model, &base)],
                HashMap::new(),
            );
            let mut inbound = json!({
                "model": "saved-alias", "max_output_tokens": 32, "stream": true,
                "input": responses_history(),
                "tools": [{"type": "function", "name": "lookup", "parameters": {"type": "object"}}]
            });
            if let Some(effort) = effort {
                inbound["reasoning"] = json!({"effort": effort});
            }
            let mut expected = inbound.clone();
            expected["model"] = json!(model);
            assert_forwarded(
                app,
                &upstream,
                "/v1/responses",
                "/v1/responses",
                inbound,
                expected,
                true,
            )
            .await;
        }
    }
}
