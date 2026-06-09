use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use litellm_rust::{
    http::routes::router,
    proxy::{
        config::{
            GatewayConfig, GeneralSettings, LiteLlmParams, McpAuthType, McpServerEntry,
            McpTransport, ModelEntry,
        },
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

fn base_config(api_base: String) -> GatewayConfig {
    GatewayConfig {
        model_list: vec![ModelEntry {
            model_name: "claude".to_owned(),
            litellm_params: LiteLlmParams {
                model: "anthropic/claude-sonnet-4-5".to_owned(),
                api_key: Some("sk-ant-test".to_owned()),
                api_base: Some(api_base),
                extra: Default::default(),
            },
        }],
        mcp_servers: Default::default(),
        general_settings: GeneralSettings {
            master_key: Some("sk-local".to_owned()),
            database_url: None,
            ..Default::default()
        },
        slack: Default::default(),
        agents: Vec::new(),
    }
}

fn config_with_mcp_server(
    api_base: String,
    url: String,
    auth_type: McpAuthType,
    auth_value: Option<&str>,
    static_headers: HashMap<String, String>,
    extra_headers: Vec<String>,
) -> GatewayConfig {
    let mut config = base_config(api_base);
    config.mcp_servers.insert(
        "linear".to_owned(),
        McpServerEntry {
            url,
            transport: McpTransport::Http,
            auth_type,
            auth_value: auth_value.map(str::to_owned),
            static_headers,
            extra_headers,
            description: None,
        },
    );
    config
}

fn bearer_config(api_base: String, mcp_url: String) -> GatewayConfig {
    config_with_mcp_server(
        api_base,
        mcp_url,
        McpAuthType::BearerToken,
        Some("mcp-secret"),
        HashMap::new(),
        Vec::new(),
    )
}

fn build_state(config: &GatewayConfig) -> Arc<AppState> {
    let mut providers = ProviderRegistry::new();
    providers::register_all(&mut providers);
    let model_router = ModelRouter::from_config(config, &providers).unwrap();
    let http = AppState::build_http_client().unwrap();
    Arc::new(AppState::new(config.clone(), model_router, http, HashMap::new(), None).unwrap())
}

fn tools_list() -> String {
    json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).to_string()
}

fn ok_tools() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0", "id": 1, "result": { "tools": [] }
    }))
}

async fn send_mcp(app: axum::Router, headers: Vec<(&str, &str)>) -> StatusCode {
    let mut builder = Request::builder().method("POST").uri("/mcp/linear");
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    let response = app
        .oneshot(builder.body(Body::from(tools_list())).unwrap())
        .await
        .unwrap();
    response.status()
}

#[tokio::test]
async fn forwards_bearer_token_as_authorization_header() {
    let llm = MockServer::start().await;
    let mcp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/mcp"))
        .and(header_match("authorization", "Bearer mcp-secret"))
        .and(header_match("mcp-protocol-version", "2025-06-18"))
        .respond_with(ok_tools())
        .mount(&mcp)
        .await;

    let config = bearer_config(llm.uri(), format!("{}/mcp", mcp.uri()));
    let app = router(build_state(&config));

    let status = send_mcp(
        app,
        vec![
            ("authorization", "Bearer sk-local"),
            ("content-type", "application/json"),
            ("mcp-protocol-version", "2025-06-18"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn rejects_mcp_without_master_key() {
    let llm = MockServer::start().await;
    let mcp = MockServer::start().await;
    let config = bearer_config(llm.uri(), format!("{}/mcp", mcp.uri()));
    let app = router(build_state(&config));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/linear")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(tools_list()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn forwards_api_key_as_x_api_key_header() {
    let llm = MockServer::start().await;
    let mcp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/mcp"))
        .and(header_match("x-api-key", "mcp-secret"))
        .respond_with(ok_tools())
        .mount(&mcp)
        .await;

    let config = config_with_mcp_server(
        llm.uri(),
        format!("{}/mcp", mcp.uri()),
        McpAuthType::ApiKey,
        Some("mcp-secret"),
        HashMap::new(),
        Vec::new(),
    );
    let app = router(build_state(&config));

    let status = send_mcp(app, vec![("authorization", "Bearer sk-local")]).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn forwards_static_headers() {
    let llm = MockServer::start().await;
    let mcp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/mcp"))
        .and(header_match("x-workspace", "prod"))
        .respond_with(ok_tools())
        .mount(&mcp)
        .await;

    let config = config_with_mcp_server(
        llm.uri(),
        format!("{}/mcp", mcp.uri()),
        McpAuthType::None,
        None,
        HashMap::from([("x-workspace".to_owned(), "prod".to_owned())]),
        Vec::new(),
    );
    let app = router(build_state(&config));

    let status = send_mcp(app, vec![("authorization", "Bearer sk-local")]).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn forwards_allowlisted_inbound_header() {
    let llm = MockServer::start().await;
    let mcp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/mcp"))
        .and(header_match("x-trace-id", "t1"))
        .respond_with(ok_tools())
        .mount(&mcp)
        .await;

    let config = config_with_mcp_server(
        llm.uri(),
        format!("{}/mcp", mcp.uri()),
        McpAuthType::None,
        None,
        HashMap::new(),
        vec!["x-trace-id".to_owned()],
    );
    let app = router(build_state(&config));

    let status = send_mcp(
        app,
        vec![("authorization", "Bearer sk-local"), ("x-trace-id", "t1")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn never_forwards_master_key_upstream() {
    let llm = MockServer::start().await;
    let mcp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/mcp"))
        .and(header_match("x-api-key", "mcp-secret"))
        .respond_with(ok_tools())
        .mount(&mcp)
        .await;

    let config = config_with_mcp_server(
        llm.uri(),
        format!("{}/mcp", mcp.uri()),
        McpAuthType::ApiKey,
        Some("mcp-secret"),
        HashMap::new(),
        // Even though authorization is allowlisted, it must be denied.
        vec!["authorization".to_owned()],
    );
    let app = router(build_state(&config));

    let status = send_mcp(app, vec![("authorization", "Bearer sk-local")]).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn unknown_mcp_server_returns_404() {
    let llm = MockServer::start().await;
    let mcp = MockServer::start().await;
    let config = bearer_config(llm.uri(), format!("{}/mcp", mcp.uri()));
    let app = router(build_state(&config));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/nope")
                .header(header::AUTHORIZATION, "Bearer sk-local")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(tools_list()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
