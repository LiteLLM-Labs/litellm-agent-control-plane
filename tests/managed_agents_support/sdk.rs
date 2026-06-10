use futures_util::StreamExt;
use litellm_rust::sdk::agents::{
    AgentEvent, AgentEventStream, AgentModel, AgentRuntime, CreateAgentParams,
    CreateEnvironmentParams, CreateSessionParams, Lap, LapConfig, ManagedAgent, ManagedSessionRef,
    SendEventsParams, SendEventsResponse, Session, MANAGED_AGENTS_BETA,
};
use serde_json::json;
use wiremock::{
    matchers::{body_json, header, method, path},
    Mock, MockServer, ResponseTemplate,
};

#[path = "sdk_cursor.rs"]
mod sdk_cursor;

pub use sdk_cursor::{
    assert_cursor_events_match_reference, assert_initial_cursor_stream, create_cursor_session,
    mount_cursor_stream_conformance, register_cursor_session, send_cursor_prompt, CURSOR_AGENT_ID,
    LAP_CURSOR_SESSION_ID,
};

fn client(server: &MockServer) -> Lap {
    let config = LapConfig {
        anthropic_api_key: Some("sk-ant-test".to_owned()),
        anthropic_base_url: server.uri(),
        ..LapConfig::default()
    };
    Lap::new(config)
}

pub async fn mount_claude_agent_create(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/v1/agents"))
        .and(header("x-api-key", "sk-ant-test"))
        .and(header("anthropic-beta", MANAGED_AGENTS_BETA))
        .and(body_json(json!({
            "name": "Coding Assistant",
            "model": "claude-opus-4-8",
            "system": "Write clean code.",
            "tools": [{ "type": "agent_toolset_20260401" }]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "agent_123",
            "version": 1
        })))
        .mount(server)
        .await;
}

pub async fn create_claude_agent(server: &MockServer) -> ManagedAgent {
    client(server)
        .beta()
        .agents()
        .create(CreateAgentParams {
            lap_agent_runtime: AgentRuntime::ClaudeManagedAgents,
            lap_provider_options: None,
            name: "Coding Assistant".to_owned(),
            model: AgentModel::from("claude-opus-4-8"),
            system: "Write clean code.".to_owned(),
            description: None,
            tools: vec![json!({ "type": "agent_toolset_20260401" })],
            mcp_servers: Vec::new(),
            env_vars: None,
            workspace: None,
            metadata: None,
        })
        .await
        .unwrap()
}

pub async fn mount_session_round_trip(server: &MockServer) {
    mount_environment_create(server).await;
    mount_session_create(server).await;
    mount_session_event_send(server).await;
}

pub async fn mount_registered_claude_session_send(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/v1/sessions/sesn_provider_123/events"))
        .and(body_json(json!({
            "events": [{
                "type": "user.message",
                "content": [{ "type": "text", "text": "Create fibonacci.txt" }]
            }]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": [] })))
        .mount(server)
        .await;
}

pub async fn register_claude_session_and_send_events(server: &MockServer) -> SendEventsResponse {
    let client = client(server);
    client
        .register_session(ManagedSessionRef {
            session_id: "lap_ses_123".to_owned(),
            lap_agent_runtime: AgentRuntime::ClaudeManagedAgents,
            provider_session_id: Some("sesn_provider_123".to_owned()),
            provider_agent_id: None,
            provider_run_id: None,
        })
        .unwrap();
    send_session_event(&client, "lap_ses_123").await
}

async fn mount_environment_create(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/v1/environments"))
        .and(body_json(json!({
            "name": "quickstart-env",
            "config": {
                "type": "cloud",
                "networking": { "type": "unrestricted" }
            }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "env_123" })))
        .mount(server)
        .await;
}

async fn mount_session_create(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/v1/sessions"))
        .and(body_json(json!({
            "agent": "agent_123",
            "environment_id": "env_123",
            "title": "Quickstart session"
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "sesn_123" })))
        .mount(server)
        .await;
}

async fn mount_session_event_send(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/v1/sessions/sesn_123/events"))
        .and(body_json(json!({
            "events": [{
                "type": "user.message",
                "content": [{ "type": "text", "text": "Create fibonacci.txt" }]
            }]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": [] })))
        .mount(server)
        .await;
}

pub async fn create_session_and_send_events(server: &MockServer) -> (Session, SendEventsResponse) {
    let client = client(server);
    let environment_id = create_environment(&client).await;
    let session = create_session(&client, environment_id).await;
    let sent = send_session_event(&client, &session.id).await;
    (session, sent)
}

async fn create_environment(client: &Lap) -> String {
    client
        .beta()
        .environments()
        .create(CreateEnvironmentParams {
            lap_agent_runtime: AgentRuntime::ClaudeManagedAgents,
            name: "quickstart-env".to_owned(),
            config: json!({ "type": "cloud", "networking": { "type": "unrestricted" } }),
            description: None,
            scope: None,
        })
        .await
        .unwrap()
        .id
}

async fn create_session(client: &Lap, environment_id: String) -> Session {
    client
        .beta()
        .sessions()
        .create(CreateSessionParams {
            agent: "agent_123".to_owned(),
            environment_id,
            title: "Quickstart session".to_owned(),
            lap_agent_runtime: None,
            metadata: None,
            vault_ids: None,
            resources: None,
        })
        .await
        .unwrap()
}

async fn send_session_event(client: &Lap, session_id: &str) -> SendEventsResponse {
    client
        .beta()
        .sessions()
        .events()
        .send(
            session_id,
            SendEventsParams {
                events: vec![json!({
                    "type": "user.message",
                    "content": [{ "type": "text", "text": "Create fibonacci.txt" }]
                })],
            },
        )
        .await
        .unwrap()
}

pub async fn mount_session_stream(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/v1/sessions/sesn_123/events/stream"))
        .and(header("anthropic-beta", MANAGED_AGENTS_BETA))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "event: agent.message\n\
             data: {\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}\n\n\
             data: {\"type\":\"session.status_idle\"}\n\n",
        ))
        .mount(server)
        .await;
}

pub async fn stream_session_events(client: &Lap, session_id: &str) -> Vec<AgentEvent> {
    let stream = client
        .beta()
        .sessions()
        .events()
        .stream(session_id)
        .await
        .unwrap();
    collect_events(stream).await
}

pub async fn stream_mock_session_events(server: &MockServer, session_id: &str) -> Vec<AgentEvent> {
    stream_session_events(&client(server), session_id).await
}

pub fn opencode_client(server: &MockServer) -> Lap {
    let config = LapConfig {
        opencode_base_url: Some(server.uri()),
        opencode_password: Some("pw".to_owned()),
        ..Default::default()
    };
    Lap::new(config)
}

pub async fn mount_opencode_session_round_trip(server: &MockServer) {
    mount_opencode_session_create(server).await;
    mount_opencode_message_send(server).await;
}

async fn mount_opencode_session_create(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/session"))
        .and(header("authorization", "Basic b3BlbmNvZGU6cHc="))
        .and(body_json(json!({ "title": "OpenCode session" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "sesn_open",
            "title": "OpenCode session"
        })))
        .mount(server)
        .await;
}

async fn mount_opencode_message_send(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/session/sesn_open/message"))
        .and(header("authorization", "Basic b3BlbmNvZGU6cHc="))
        .and(body_json(json!({
            "parts": [{ "type": "text", "text": "Create fibonacci.txt" }]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "info": { "id": "msg_123", "role": "assistant" },
            "parts": [{ "type": "text", "text": "done" }]
        })))
        .mount(server)
        .await;
}

pub async fn create_opencode_session_and_send(
    server: &MockServer,
) -> (Session, SendEventsResponse) {
    let client = opencode_client(server);
    let session = client
        .beta()
        .sessions()
        .create(CreateSessionParams::opencode("OpenCode session"))
        .await
        .unwrap();
    let sent = send_session_event(&client, &session.id).await;
    (session, sent)
}

async fn collect_events(mut stream: AgentEventStream) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        events.push(event.unwrap());
    }
    events
}
