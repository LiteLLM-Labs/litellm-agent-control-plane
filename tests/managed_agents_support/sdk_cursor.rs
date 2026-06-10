use litellm_rust::sdk::agents::{
    parse_sse, AgentEvent, AgentModel, AgentRuntime, CreateAgentParams, CreateSessionParams, Lap,
    LapConfig, ManagedAgent, ManagedSessionRef, SendEventsParams, Session,
};
use serde_json::{json, Value};
use wiremock::{
    matchers::{body_json, header, method, path},
    Mock, MockServer, ResponseTemplate,
};

pub const CURSOR_AGENT_ID: &str = "bc-00000000-0000-0000-0000-000000000001";
pub const LAP_CURSOR_SESSION_ID: &str = "lap_ses_123";

const CURSOR_INITIAL_RUN_ID: &str = "run-00000000-0000-0000-0000-000000000001";
const CURSOR_RESUME_RUN_ID: &str = "run-00000000-0000-0000-0000-000000000002";

fn cursor_client(server: &MockServer) -> Lap {
    let config = LapConfig {
        cursor_api_key: Some("cursor-test".to_owned()),
        cursor_base_url: server.uri(),
        ..LapConfig::default()
    };
    Lap::new(config)
}

pub async fn mount_cursor_stream_conformance(server: &MockServer) {
    mount_cursor_agent_create(server).await;
    mount_cursor_resume_run(server).await;
    mount_cursor_initial_stream(server).await;
    mount_cursor_resume_stream(server).await;
}

async fn mount_cursor_agent_create(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/v1/agents"))
        .and(header("authorization", "Bearer cursor-test"))
        .and(body_json(json!({
            "prompt": { "text": "You are a coding assistant." },
            "model": { "id": "composer-2" },
            "name": "Coding Assistant",
            "mcpServers": [{
                "name": "linear",
                "type": "http",
                "url": "https://mcp.linear.app/sse"
            }]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "agent": {
                "id": CURSOR_AGENT_ID,
                "name": "Quickstart session",
                "status": "ACTIVE",
                "latestRunId": CURSOR_INITIAL_RUN_ID
            },
            "run": {
                "id": CURSOR_INITIAL_RUN_ID,
                "agentId": CURSOR_AGENT_ID,
                "status": "CREATING"
            }
        })))
        .mount(server)
        .await;
}

async fn mount_cursor_resume_run(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path(format!("/v1/agents/{CURSOR_AGENT_ID}/runs")))
        .and(header("authorization", "Bearer cursor-test"))
        .and(body_json(json!({
            "prompt": { "text": "Add a troubleshooting note" }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "run": {
                "id": CURSOR_RESUME_RUN_ID,
                "agentId": CURSOR_AGENT_ID,
                "status": "CREATING"
            }
        })))
        .mount(server)
        .await;
}

async fn mount_cursor_initial_stream(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path(format!(
            "/v1/agents/{CURSOR_AGENT_ID}/runs/{CURSOR_INITIAL_RUN_ID}/stream"
        )))
        .and(header("authorization", "Bearer cursor-test"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "event: status\n\
             data: {\"runId\":\"run-00000000-0000-0000-0000-000000000001\",\"status\":\"RUNNING\"}\n\n\
             event: assistant\n\
             data: {\"text\":\"initial\"}\n\n\
             event: result\n\
             data: {\"runId\":\"run-00000000-0000-0000-0000-000000000001\",\"status\":\"FINISHED\"}\n\n",
        ))
        .mount(server)
        .await;
}

async fn mount_cursor_resume_stream(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path(format!(
            "/v1/agents/{CURSOR_AGENT_ID}/runs/{CURSOR_RESUME_RUN_ID}/stream"
        )))
        .and(header("authorization", "Bearer cursor-test"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "event: status\n\
             data: {\"runId\":\"run-00000000-0000-0000-0000-000000000002\",\"status\":\"RUNNING\"}\n\n\
             event: interaction_update\n\
             data: {\"type\":\"text-delta\",\"text\":\"duplicate text delta\"}\n\n\
             event: assistant\n\
             data: {\"text\":\"I'll\"}\n\n\
             event: interaction_update\n\
             data: {\"type\":\"text-delta\",\"text\":\"I'll\"}\n\n\
             event: assistant\n\
             data: {\"text\":\" update it.\"}\n\n\
             event: interaction_update\n\
             data: {\"type\":\"token-delta\",\"tokens\":3}\n\n\
             event: tool_call\n\
             data: {\"callId\":\"call-1\",\"name\":\"edit_file\",\"status\":\"running\",\"args\":{\"path\":\"README.md\"}}\n\n\
             event: interaction_update\n\
             data: {\"type\":\"turn-ended\"}\n\n\
             event: interaction_update\n\
             data: {\"type\":\"step-completed\"}\n\n\
             event: result\n\
             data: {\"runId\":\"run-00000000-0000-0000-0000-000000000002\",\"status\":\"FINISHED\",\"text\":\"Done.\"}\n\n\
             event: done\n\
             data: {\"runId\":\"run-00000000-0000-0000-0000-000000000002\"}\n\n\
             event: heartbeat\n\
             data: {}\n\n",
        ))
        .mount(server)
        .await;
}

pub async fn create_cursor_session(server: &MockServer) -> (Lap, Session) {
    let client = cursor_client(server);
    let agent = create_cursor_agent(&client).await;
    let session = create_cursor_runtime_session(&client, agent.id).await;
    (client, session)
}

async fn create_cursor_agent(client: &Lap) -> ManagedAgent {
    client
        .beta()
        .agents()
        .create(CreateAgentParams {
            lap_agent_runtime: AgentRuntime::Cursor,
            lap_provider_options: None,
            name: "Coding Assistant".to_owned(),
            model: AgentModel::from("composer-2"),
            system: "You are a coding assistant.".to_owned(),
            description: None,
            tools: Vec::new(),
            mcp_servers: vec![json!({
                "name": "linear",
                "type": "url",
                "url": "https://mcp.linear.app/sse"
            })],
            env_vars: None,
            workspace: None,
            metadata: None,
        })
        .await
        .unwrap()
}

async fn create_cursor_runtime_session(client: &Lap, agent_id: String) -> Session {
    client
        .beta()
        .sessions()
        .create(CreateSessionParams {
            agent: agent_id,
            environment_id: "quickstart-env".to_owned(),
            title: "Quickstart session".to_owned(),
            lap_agent_runtime: Some(AgentRuntime::Cursor),
            metadata: None,
            vault_ids: None,
            resources: None,
        })
        .await
        .unwrap()
}

pub async fn send_cursor_prompt(client: &Lap) {
    client
        .beta()
        .sessions()
        .events()
        .send(
            LAP_CURSOR_SESSION_ID,
            SendEventsParams {
                events: vec![json!({
                    "type": "user.message",
                    "content": [{ "type": "text", "text": "Add a troubleshooting note" }]
                })],
            },
        )
        .await
        .unwrap();
}

pub fn register_cursor_session(client: &Lap, provider_session_id: String) {
    client
        .register_session(ManagedSessionRef {
            session_id: LAP_CURSOR_SESSION_ID.to_owned(),
            lap_agent_runtime: AgentRuntime::Cursor,
            provider_session_id: Some(provider_session_id),
            provider_agent_id: Some(CURSOR_AGENT_ID.to_owned()),
            provider_run_id: None,
        })
        .unwrap();
}

pub fn assert_initial_cursor_stream(events: &[AgentEvent]) {
    assert_eq!(events[1].event_type, "agent.message");
    assert_eq!(events[1].data["content"][0]["text"], "initial");
}

pub fn assert_cursor_events_match_reference(events: &[AgentEvent]) {
    let reference_events = anthropic_reference_stream_events();
    assert_eq!(event_types(events), event_types(&reference_events));
    assert!(events
        .iter()
        .all(|event| !event.event_type.starts_with("cursor.")));

    assert_eq!(events[1].event_type, "agent.message");
    assert_eq!(
        Value::Object(events[1].data.clone()),
        json!({
            "content": [{
                "type": "text",
                "text": "I'll update it."
            }]
        })
    );
    assert_eq!(events[2].event_type, "agent.tool_use");
    assert_eq!(
        Value::Object(events[2].data.clone()),
        json!({
            "id": "call-1",
            "name": "edit_file",
            "input": { "path": "README.md" }
        })
    );
    assert_eq!(events[3].event_type, "session.status_idle");
    assert_eq!(
        Value::Object(events[3].data.clone()),
        json!({
            "stop_reason": { "type": "end_turn" }
        })
    );
}

fn anthropic_reference_stream_events() -> Vec<AgentEvent> {
    parse_sse(
        "data: {\"type\":\"session.status_running\",\"id\":\"evt_running\",\"processed_at\":\"2026-01-01T00:00:00Z\"}\n\n\
         data: {\"type\":\"agent.message\",\"id\":\"evt_message\",\"processed_at\":\"2026-01-01T00:00:01Z\",\"content\":[{\"type\":\"text\",\"text\":\"I'll update it.\"}]}\n\n\
         data: {\"type\":\"agent.tool_use\",\"id\":\"call-1\",\"processed_at\":\"2026-01-01T00:00:02Z\",\"name\":\"edit_file\",\"input\":{\"path\":\"README.md\"}}\n\n\
         data: {\"type\":\"session.status_idle\",\"id\":\"evt_idle\",\"processed_at\":\"2026-01-01T00:00:03Z\",\"stop_reason\":{\"type\":\"end_turn\"}}\n\n",
    )
    .unwrap()
}

fn event_types(events: &[AgentEvent]) -> Vec<&str> {
    events
        .iter()
        .map(|event| event.event_type.as_str())
        .collect()
}
