use std::{collections::HashMap, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use litellm_rust::{
    db::managed_agents::pool as managed_agents_pool,
    http::routes::router,
    proxy::{
        config::{GatewayConfig, GeneralSettings, LiteLlmParams, ModelEntry},
        provider_credentials::{self, ProviderCredentialInput},
        state::AppState,
    },
    sdk::{
        providers::{self, ProviderRegistry},
        routing::Router as ModelRouter,
    },
};
use serde_json::json;
use sqlx::PgPool;
use tower::util::ServiceExt;
use wiremock::{
    matchers::{header as header_match, method, path},
    Mock, MockServer, ResponseTemplate,
};

#[tokio::test]
async fn responses_uses_db_backed_openai_credentials() {
    let Some(pool) = test_pool().await else {
        eprintln!("skipping responses integration test: TEST_DATABASE_URL is not set");
        return;
    };
    let upstream = MockServer::start().await;
    mock_responses_upstream(&upstream).await;
    let config = test_config(upstream.uri());
    save_openai_credential(&pool, &config, upstream.uri()).await;

    let app = router(build_state(config, pool));
    let response = app.oneshot(responses_request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["output_text"], "ok");
}

async fn mock_responses_upstream(upstream: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .and(header_match("authorization", "Bearer sk-openai-db"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "resp_test",
            "object": "response",
            "status": "completed",
            "model": "gpt-5.5",
            "output": [],
            "output_text": "ok"
        })))
        .mount(upstream)
        .await;
}

async fn save_openai_credential(pool: &PgPool, config: &GatewayConfig, api_base: String) {
    provider_credentials::save(
        pool,
        config,
        "openai",
        ProviderCredentialInput {
            api_key: "sk-openai-db".to_owned(),
            api_base,
        },
    )
    .await
    .unwrap();
}

fn responses_request() -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header(header::AUTHORIZATION, "Bearer sk-local")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({
                "model": "gpt-5.5",
                "input": "Reply with exactly: ok",
                "max_output_tokens": 16
            })
            .to_string(),
        ))
        .unwrap()
}

async fn test_pool() -> Option<PgPool> {
    let database_url = std::env::var("TEST_DATABASE_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())?;
    let pool = managed_agents_pool::connect(&database_url).await.unwrap();
    managed_agents_pool::migrate(&pool).await.unwrap();
    sqlx::query(
        r#"DELETE FROM "LiteLLM_CredentialsTable" WHERE credential_name = 'provider:openai'"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    Some(pool)
}

fn test_config(api_base: String) -> GatewayConfig {
    GatewayConfig {
        model_list: vec![ModelEntry {
            model_name: "gpt-5.5".to_owned(),
            litellm_params: LiteLlmParams {
                model: "openai/gpt-5.5".to_owned(),
                api_key: None,
                api_base: Some(api_base),
                extra: Default::default(),
            },
        }],
        mcp_servers: Default::default(),
        general_settings: GeneralSettings {
            master_key: Some("sk-local".to_owned()),
            database_url: Some("postgres://test".to_owned()),
            ..Default::default()
        },
        slack: Default::default(),
        agents: Vec::new(),
    }
}

fn build_state(config: GatewayConfig, pool: PgPool) -> Arc<AppState> {
    let mut providers = ProviderRegistry::new();
    providers::register_all(&mut providers);
    let model_router = ModelRouter::from_config(&config, &providers).unwrap();
    let http = AppState::build_http_client().unwrap();
    Arc::new(AppState::new(config, model_router, http, HashMap::new(), Some(pool)).unwrap())
}
