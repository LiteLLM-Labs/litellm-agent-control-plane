//! Live integration test: drive an opencode-behind-Anthropic-spec server through the
//! LAP SDK (`litellm_rust`, the `claude_managed_agents` runtime) with NO opencode-specific
//! code — only by pointing `anthropic_base_url`/`anthropic_api_key` at the server.
//!
//! This proves the SDK's `ClaudeManagedAgents` path works against our
//! opencode-behind-Anthropic server completely unchanged: the same agent/environment/
//! session/events/stream calls used against api.anthropic.com talk to the local server
//! purely via configuration.
//!
//! This is a LIVE test. It is `#[ignore]` by default because it requires the server
//! running (default `http://localhost:8080`, override with `OPENCODE_ANTHROPIC_BASE`).
//!
//! Run it with:
//!     cargo test --test opencode_anthropic_server_live -- --ignored --nocapture
//!
//! The test asserts only the plumbing: agent + session are created with non-empty ids
//! and the SSE stream opens without error. It does NOT require a specific assistant
//! message, since LLM token output depends on a provider key configured on the server.

use std::time::Duration;

use futures_util::StreamExt;
use litellm_rust::sdk::agents::{
    AgentModel, AgentRuntime, CreateAgentParams, CreateEnvironmentParams, CreateSessionParams, Lap,
    LapConfig, SendEventsParams,
};
use serde_json::json;

fn live_lap(base: String) -> Lap {
    // No opencode-specific config — just the Anthropic base URL + key. The
    // server speaks the Anthropic managed-agents spec.
    Lap::new(LapConfig {
        anthropic_api_key: Some("live-test".into()),
        anthropic_base_url: base,
        ..LapConfig::default()
    })
}

async fn create_live_agent(lap: &Lap, model: &str) -> String {
    let agent = lap
        .beta()
        .agents()
        .create(CreateAgentParams {
            lap_agent_runtime: AgentRuntime::ClaudeManagedAgents,
            lap_provider_options: None,
            name: "Live SDK Test".into(),
            model: AgentModel::from(model),
            system: "You are a terse assistant.".into(),
            description: None,
            tools: Vec::new(),
            mcp_servers: Vec::new(),
            env_vars: None,
            workspace: None,
            metadata: None,
        })
        .await
        .expect("agents().create should succeed");
    assert!(!agent.id.is_empty(), "agent id should be non-empty");
    println!("[live] created agent id={}", agent.id);
    agent.id
}

async fn create_live_env(lap: &Lap) -> String {
    let env = lap
        .beta()
        .environments()
        .create(CreateEnvironmentParams {
            lap_agent_runtime: AgentRuntime::ClaudeManagedAgents,
            name: "live-env".into(),
            config: json!({}),
            description: None,
            scope: None,
        })
        .await
        .expect("environments().create should succeed");
    assert!(!env.id.is_empty(), "environment id should be non-empty");
    println!("[live] created environment id={}", env.id);
    env.id
}

async fn create_live_session(lap: &Lap, agent_id: &str, env_id: &str) -> String {
    let session = lap
        .beta()
        .sessions()
        .create(CreateSessionParams {
            agent: agent_id.to_owned(),
            environment_id: env_id.to_owned(),
            title: "live session".into(),
            lap_agent_runtime: Some(AgentRuntime::ClaudeManagedAgents),
            metadata: None,
            vault_ids: None,
            resources: None,
        })
        .await
        .expect("sessions().create should succeed");
    assert!(!session.id.is_empty(), "session id should be non-empty");
    println!("[live] created session id={}", session.id);
    session.id
}

async fn send_live_message(lap: &Lap, session_id: &str) {
    lap.beta()
        .sessions()
        .events()
        .send(
            session_id,
            SendEventsParams {
                events: vec![json!({
                    "type": "user.message",
                    "content": [{ "type": "text", "text": "Name the three primary colors, comma separated." }]
                })],
            },
        )
        .await
        .expect("sessions().events().send should succeed");
    println!("[live] sent user.message to session {session_id}");
}

/// Drain the SSE stream until idle; returns (event_count, assistant_text).
async fn drain_live_stream(lap: &Lap, session_id: &str) -> (usize, String) {
    let mut stream = lap
        .beta()
        .sessions()
        .events()
        .stream(session_id)
        .await
        .expect("sessions().events().stream should open");
    println!("[live] stream opened for session {session_id}");

    let mut received = 0usize;
    let mut text = String::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(30), stream.next()).await {
            Ok(Some(Ok(event))) => {
                received += 1;
                println!("[live] event #{received}: event_type={}", event.event_type);
                if event.event_type == "agent.message" {
                    if let Some(content) = event.data.get("content").and_then(|c| c.as_array()) {
                        for block in content {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                text.push_str(t);
                                print!("{t}");
                            }
                        }
                    }
                }
                if event.event_type == "session.status_idle" {
                    println!("[live] session idle — turn complete");
                    break;
                }
            }
            Ok(Some(Err(err))) => {
                println!("[live] stream error (acceptable for plumbing test): {err}");
                break;
            }
            Ok(None) => {
                println!("[live] stream ended after {received} event(s)");
                break;
            }
            Err(_) => {
                println!("[live] no further events within timeout after {received} event(s)");
                break;
            }
        }
    }
    (received, text)
}

#[tokio::test]
#[ignore = "live test: requires the opencode-behind-Anthropic server running (see OPENCODE_ANTHROPIC_BASE)"]
async fn drives_opencode_anthropic_server_via_claude_managed_agents() {
    let base =
        std::env::var("OPENCODE_ANTHROPIC_BASE").unwrap_or_else(|_| "http://localhost:8080".into());
    let model = std::env::var("OPENCODE_ANTHROPIC_MODEL")
        .unwrap_or_else(|_| "litellm/claude-sonnet-4-5".into());
    println!("[live] target server: {base} | model: {model}");

    let lap = live_lap(base);
    let agent_id = create_live_agent(&lap, &model).await;
    let env_id = create_live_env(&lap).await;
    let session_id = create_live_session(&lap, &agent_id, &env_id).await;
    send_live_message(&lap, &session_id).await;
    let (received, assistant_text) = drain_live_stream(&lap, &session_id).await;

    if !assistant_text.trim().is_empty() {
        println!("\n[live] >>> ASSISTANT SAID: {}", assistant_text.trim());
    }
    println!(
        "[live] SUCCESS: SDK claude_managed_agents path drove the opencode-behind-Anthropic \
         server unchanged — agent={agent_id}, environment={env_id}, session={session_id}, \
         stream connected, {received} event(s) observed."
    );
}
