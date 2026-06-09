use std::{collections::HashMap, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use futures_util::StreamExt;
use litellm_rust::{
    agents::config::{AgentDefinition, E2bSandboxParams},
    http::routes::router,
    proxy::{
        config::{GatewayConfig, GeneralSettings},
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
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

#[tokio::test]
async fn starts_agent_and_streams_e2b_output() {
    let e2b = mock_e2b().await;
    let app = router(build_state(&test_config(e2b.uri())));

    let (event_url, run_id) = start_agent_run(&app).await;
    let body = read_events_until_completed(app, event_url).await;

    assert!(body.contains("\"type\":\"session.status\""));
    assert!(body.contains("\"type\":\"message.updated\""));
    assert!(body.contains("\"type\":\"message.part.updated\""));
    assert!(body.contains("\"type\":\"message.part.delta\""));
    assert!(body.contains("\"delta\":\"hello \""));
    assert!(body.contains("\"delta\":\"from sandbox\\n\""));
    assert!(body.contains("\"field\":\"text\""));
    assert!(body.contains("\"sessionID\""));
    assert!(!body.contains("npm notice"));
    assert!(!body.contains("\"stream\":\"stderr\""));
    assert!(!body.contains("\"event\":{\"start\""));
    assert!(!body.contains("\"event\":{\"end\""));
    assert!(body.contains("\"type\":\"session.idle\""));
    assert!(body.contains(&run_id));
}

async fn mock_e2b() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/sandboxes"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "templateID": "litellm-4gb",
            "sandboxID": "sbx_test",
            "clientID": "client_test",
            "envdVersion": "test",
            "alias": "base",
            "envdAccessToken": "envd-test",
            "trafficAccessToken": "traffic-test",
            "domain": server.uri()
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/process.Process/Start"))
        .respond_with(
            ResponseTemplate::new(200).set_body_bytes(connect_json_frames(&[
                br#"{"event":{"start":{"pid":1470}}}"#,
                br#"{"stdout":"eyJ0eXBlIjoic3RyZWFtX2V2ZW50Iiwic2Vzc2lvbl9pZCI6InNieF90ZXN0IiwiZXZlbnQiOnsidHlwZSI6ImNvbnRlbnRfYmxvY2tfZGVsdGEiLCJpbmRleCI6MCwiZGVsdGEiOnsidHlwZSI6InRleHRfZGVsdGEiLCJ0ZXh0IjoiaGVsbG8gIn19fQo="}"#,
                br#"{"stdout":"eyJ0eXBlIjoic3RyZWFtX2V2ZW50Iiwic2Vzc2lvbl9pZCI6InNieF90ZXN0IiwiZXZlbnQiOnsidHlwZSI6ImNvbnRlbnRfYmxvY2tfZGVsdGEiLCJpbmRleCI6MCwiZGVsdGEiOnsidHlwZSI6InRleHRfZGVsdGEiLCJ0ZXh0IjoiZnJvbSBzYW5kYm94XG4ifX19Cg=="}"#,
                br#"{"stdout":"eyJ0eXBlIjoicmVzdWx0Iiwic3VidHlwZSI6InN1Y2Nlc3MiLCJzZXNzaW9uX2lkIjoic2J4X3Rlc3QiLCJkdXJhdGlvbl9tcyI6MSwiZHVyYXRpb25fYXBpX21zIjoxLCJpc19lcnJvciI6ZmFsc2UsIm51bV90dXJucyI6MSwidG90YWxfY29zdF91c2QiOjAsInVzYWdlIjp7fSwicmVzdWx0IjoiaGVsbG8gZnJvbSBzYW5kYm94XG4ifQo="}"#,
                br#"{"stderr":"bnBtIG5vdGljZQo="}"#,
                br#"{"event":{"end":{"exited":true,"status":"exit status 0"}}}"#,
            ])),
        )
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/sandboxes/sbx_test"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    server
}

fn connect_json_frames(payloads: &[&[u8]]) -> Vec<u8> {
    let mut frames = Vec::new();
    for payload in payloads {
        frames.push(0);
        frames.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frames.extend_from_slice(payload);
    }
    frames
}

async fn start_agent_run(app: &axum::Router) -> (String, String) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/agents/untitled-agent/run")
                .header(header::AUTHORIZATION, "Bearer sk-local")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "prompt": "say hello" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let event_url = body["event_url"].as_str().unwrap();
    assert_eq!(event_url, "/event");
    let run_id = body["run_id"].as_str().unwrap();
    (event_url.to_owned(), run_id.to_owned())
}

async fn read_events_until_completed(app: axum::Router, event_url: String) -> String {
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("{event_url}?key=sk-local"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/event-stream"
    );
    let mut stream = response.into_body().into_data_stream();
    let body = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let mut body = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.unwrap();
            body.push_str(std::str::from_utf8(&chunk).unwrap());
            if body.contains("\"type\":\"session.idle\"") {
                break;
            }
        }
        body
    })
    .await
    .unwrap();
    body
}

fn test_config(e2b_api_base: String) -> GatewayConfig {
    GatewayConfig {
        model_list: Vec::new(),
        mcp_servers: Default::default(),
        general_settings: GeneralSettings {
            master_key: Some("sk-local".to_owned()),
            database_url: None,
            sandbox_choice: Some("e2b".to_owned()),
            e2b_sandbox_params: E2bSandboxParams {
                e2b_api_key: Some("e2b-test".to_owned()),
                e2b_template: "litellm-4gb".to_owned(),
                timeout_seconds: 1800,
                workspace_dir: "/home/user/workspace".to_owned(),
                e2b_api_base,
                envs: Default::default(),
            },
            ..Default::default()
        },
        slack: Default::default(),
        agents: vec![AgentDefinition {
            id: None,
            name: "Untitled agent".to_owned(),
            description: Some("A blank starting point with the core toolset.".to_owned()),
            model: "claude-sonnet-4-6".to_owned(),
            harness: None,
            system: "You are a general-purpose agent.".to_owned(),
            mcp_servers: Vec::new(),
            tools: vec![HashMap::from([(
                "type".to_owned(),
                serde_yaml::Value::String("agent_toolset_20260401".to_owned()),
            )])],
            skills: Vec::new(),
        }],
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
