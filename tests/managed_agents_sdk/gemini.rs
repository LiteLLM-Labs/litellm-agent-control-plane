use litellm_rust::sdk::agents::{
    AgentEventKind, AgentModel, AgentRuntime, AgentWorkspace, CreateAgentParams,
    CreateSessionParams, DeleteAgentParams, GetAgentParams, Lap, LapConfig, ListAgentsParams,
    SendEventsParams,
};
use serde_json::json;
use wiremock::{
    matchers::{body_json, header, method, path},
    Mock, MockServer, ResponseTemplate,
};

use super::super::sdk_support;

#[tokio::test]
async fn creates_gemini_agent_and_invokes_interaction() {
    let server = MockServer::start().await;
    let interaction = json!({
        "object": "interaction",
        "id": "interaction_123",
        "status": "completed",
        "steps": [{
            "type": "model_output",
            "content": [{ "type": "text", "text": "done" }]
        }]
    });
    let agent = json!({
        "id": "coding-assistant",
        "description": "Handles coding tasks.",
        "base_agent": "antigravity-preview-05-2026",
        "system_instruction": "Write clean code.",
        "tools": [{ "type": "code_execution" }]
    });
    mount_gemini_agent_routes(&server, &agent).await;
    mount_gemini_interaction_routes(&server, &interaction).await;

    let client = Lap::new(LapConfig {
        gemini_api_key: Some("sk-gem-test".to_owned()),
        gemini_base_url: server.uri(),
        ..LapConfig::default()
    });
    let created = create_gemini_agent(&client).await;
    assert_eq!(created.id, "coding-assistant");
    assert_eq!(
        created.model.as_deref(),
        Some("antigravity-preview-05-2026")
    );
    assert_gemini_agent_crud(&client).await;
    let session = create_gemini_session(&client).await;
    let sent = send_gemini_prompt(&client, &session.id).await;
    assert_eq!(sent.raw["id"], "interaction_123");

    let events = sdk_support::stream_session_events(&client, &session.id).await;
    assert_eq!(events[0].kind(), AgentEventKind::AgentMessage);
    assert_eq!(events[1].kind(), AgentEventKind::SessionStatusIdle);
}

async fn mount_gemini_agent_routes(server: &MockServer, agent: &serde_json::Value) {
    Mock::given(method("POST"))
        .and(path("/v1beta/agents"))
        .and(header("x-goog-api-key", "sk-gem-test"))
        .and(header("api-revision", "2026-05-20"))
        .and(body_json(json!({
            "id": "coding-assistant",
            "base_agent": "antigravity-preview-05-2026",
            "system_instruction": "Write clean code.",
            "description": "Handles coding tasks.",
            "tools": [{ "type": "code_execution" }],
            "base_environment": {
                "type": "remote",
                "sources": [{
                    "type": "repository",
                    "source": "https://github.com/acme/app",
                    "ref": "feature/gemini",
                    "target": "/workspace/repo"
                }]
            }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(agent.clone()))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1beta/agents"))
        .and(header("x-goog-api-key", "sk-gem-test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "agents": [agent.clone()],
            "nextPageToken": "next-page"
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1beta/agents/coding-assistant"))
        .and(header("x-goog-api-key", "sk-gem-test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(agent.clone()))
        .mount(server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/v1beta/agents/coding-assistant"))
        .and(header("x-goog-api-key", "sk-gem-test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(server)
        .await;
}

async fn mount_gemini_interaction_routes(server: &MockServer, interaction: &serde_json::Value) {
    Mock::given(method("POST"))
        .and(path("/v1beta/interactions"))
        .and(header("x-goog-api-key", "sk-gem-test"))
        .and(header("api-revision", "2026-05-20"))
        .and(body_json(json!({
            "agent": "coding-assistant",
            "input": "Create fibonacci.txt",
            "environment": "remote",
            "store": true
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(interaction.clone()))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1beta/interactions/interaction_123"))
        .and(header("x-goog-api-key", "sk-gem-test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(interaction.clone()))
        .mount(server)
        .await;
}

async fn create_gemini_agent(client: &Lap) -> litellm_rust::sdk::agents::ManagedAgent {
    client
        .beta()
        .agents()
        .create(CreateAgentParams {
            lap_agent_runtime: AgentRuntime::GeminiAntigravity,
            lap_provider_options: None,
            name: "Coding Assistant".to_owned(),
            model: AgentModel::from("antigravity-preview-05-2026"),
            system: "Write clean code.".to_owned(),
            description: Some("Handles coding tasks.".to_owned()),
            tools: vec![
                json!({ "type": "code_execution" }),
                json!({ "type": "bash" }),
            ],
            mcp_servers: Vec::new(),
            env_vars: None,
            workspace: Some(AgentWorkspace {
                repository: "https://github.com/acme/app".to_owned(),
                ref_name: Some("feature/gemini".to_owned()),
                auto_create_pr: false,
            }),
            metadata: None,
        })
        .await
        .unwrap()
}

async fn assert_gemini_agent_crud(client: &Lap) {
    let listed = client
        .beta()
        .agents()
        .list(ListAgentsParams {
            lap_agent_runtime: AgentRuntime::GeminiAntigravity,
            page_size: None,
            page_token: None,
        })
        .await
        .unwrap();
    assert_eq!(listed.agents.len(), 1);
    assert_eq!(listed.next_page_token.as_deref(), Some("next-page"));

    let fetched = client
        .beta()
        .agents()
        .get(GetAgentParams {
            lap_agent_runtime: AgentRuntime::GeminiAntigravity,
            id: "coding-assistant".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(fetched.id, "coding-assistant");

    let deleted = client
        .beta()
        .agents()
        .delete(DeleteAgentParams {
            lap_agent_runtime: AgentRuntime::GeminiAntigravity,
            id: "coding-assistant".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(deleted.raw, json!({}));
}

async fn create_gemini_session(client: &Lap) -> litellm_rust::sdk::agents::Session {
    let session = client
        .beta()
        .sessions()
        .create(CreateSessionParams {
            agent: "coding-assistant".to_owned(),
            environment_id: "remote".to_owned(),
            title: "Gemini session".to_owned(),
            lap_agent_runtime: Some(AgentRuntime::GeminiAntigravity),
            metadata: None,
            vault_ids: None,
            resources: None,
        })
        .await
        .unwrap();
    assert!(session.id.starts_with("gemini_ses_"));
    session
}

async fn send_gemini_prompt(
    client: &Lap,
    session_id: &str,
) -> litellm_rust::sdk::agents::SendEventsResponse {
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
