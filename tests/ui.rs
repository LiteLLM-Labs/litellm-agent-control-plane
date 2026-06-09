use std::{collections::HashMap, fs, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use litellm_rust::{
    http::routes::router,
    proxy::{
        config::{GatewayConfig, GeneralSettings, LiteLlmParams, ModelEntry},
        state::AppState,
    },
    sdk::{
        providers::{self, ProviderRegistry},
        routing::Router as ModelRouter,
    },
};
use tempfile::TempDir;
use tower::util::ServiceExt;

#[tokio::test]
async fn serves_static_ui() {
    let ui_dir = write_ui_fixture();
    std::env::set_var("LITELLM_UI_DIR", ui_dir.path());
    let app = router(build_state(&test_config()));

    assert_redirects_to_sessions(app.clone()).await;
    assert_serves_sessions_html(app.clone()).await;
    assert_serves_spa_deep_links(app).await;
}

fn write_ui_fixture() -> TempDir {
    let ui_dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(ui_dir.path().join("sessions")).unwrap();
    fs::write(ui_dir.path().join("index.html"), "<html>app shell</html>").unwrap();
    fs::write(
        ui_dir.path().join("sessions/index.html"),
        "<html>sessions</html>",
    )
    .unwrap();
    fs::write(ui_dir.path().join("404.html"), "<html>not found</html>").unwrap();
    ui_dir
}

async fn assert_redirects_to_sessions(app: axum::Router) {
    let response = get(app, "/").await;
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "/sessions/"
    );
}

async fn assert_serves_sessions_html(app: axum::Router) {
    let response = get(app, "/sessions/").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert!(std::str::from_utf8(&body).unwrap().contains("sessions"));
}

async fn assert_serves_spa_deep_links(app: axum::Router) {
    let response = get(app, "/agents/detail/?id=agent_123").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert!(std::str::from_utf8(&body).unwrap().contains("app shell"));
}

async fn get(app: axum::Router, uri: &str) -> axum::response::Response {
    app.oneshot(
        Request::builder()
            .method("GET")
            .uri(uri)
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap()
}

fn test_config() -> GatewayConfig {
    GatewayConfig {
        model_list: vec![ModelEntry {
            model_name: "claude".to_owned(),
            litellm_params: LiteLlmParams {
                model: "anthropic/claude-sonnet-4-5".to_owned(),
                api_key: Some("sk-ant-test".to_owned()),
                api_base: Some("http://127.0.0.1:1".to_owned()),
                extra: Default::default(),
            },
        }],
        mcp_servers: Default::default(),
        general_settings: GeneralSettings {
            master_key: Some("sk-local".to_owned()),
            ..Default::default()
        },
        slack: Default::default(),
        agents: Vec::new(),
    }
}

fn build_router(config: &GatewayConfig) -> ModelRouter {
    let mut providers = ProviderRegistry::new();
    providers::register_all(&mut providers);
    ModelRouter::from_config(config, &providers).unwrap()
}

fn build_state(config: &GatewayConfig) -> Arc<AppState> {
    let http = AppState::build_http_client().unwrap();
    Arc::new(
        AppState::new(
            config.clone(),
            build_router(config),
            http,
            HashMap::new(),
            None,
        )
        .unwrap(),
    )
}
