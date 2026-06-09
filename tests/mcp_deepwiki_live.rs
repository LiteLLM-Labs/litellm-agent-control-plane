use std::{
    error::Error,
    time::{SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use litellm_rust::sdk::agents::{
    AgentModel, AgentRuntime, CreateAgentParams, CreateEnvironmentParams, CreateSessionParams, Lap,
    LapConfig, SendEventsParams,
};
use serde_json::json;

struct ProviderConfig {
    runtime: AgentRuntime,
    client: Lap,
    model: &'static str,
}

fn providers() -> Vec<ProviderConfig> {
    let mut out = Vec::new();
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        out.push(ProviderConfig {
            runtime: AgentRuntime::ClaudeManagedAgents,
            client: Lap::new(LapConfig::anthropic(key)),
            model: "claude-sonnet-4-6",
        });
    }
    if let Ok(key) = std::env::var("CURSOR_API_KEY") {
        out.push(ProviderConfig {
            runtime: AgentRuntime::Cursor,
            client: Lap::new(LapConfig::cursor(key)),
            model: "default",
        });
    }
    out
}

fn suffix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[tokio::test]
#[ignore = "requires ANTHROPIC_API_KEY or CURSOR_API_KEY; makes live calls to DeepWiki MCP"]
async fn mcp_deepwiki_tool_use_across_providers() -> Result<(), Box<dyn Error>> {
    let providers = providers();
    assert!(
        !providers.is_empty(),
        "set ANTHROPIC_API_KEY or CURSOR_API_KEY to run this test"
    );
    let suffix = suffix();
    for config in &providers {
        let label = format!("{:?}", config.runtime);
        let session_id = setup_deepwiki_session(config, &label, suffix).await?;
        assert_session_uses_mcp_tool(config, &label, &session_id).await?;
        eprintln!("[{label}] ok");
    }
    Ok(())
}

async fn create_deepwiki_agent(
    config: &ProviderConfig,
    label: &str,
    suffix: u64,
) -> Result<String, Box<dyn Error>> {
    let system = match config.runtime {
        AgentRuntime::Cursor => "Use deepwiki to get the wiki structure for the anthropics/anthropic-sdk-python repository.".to_owned(),
        _ => "You are a helpful assistant. When asked to look something up, use the deepwiki MCP tool.".to_owned(),
    };
    let agent = config
        .client
        .beta()
        .agents()
        .create(CreateAgentParams {
            lap_agent_runtime: config.runtime,
            lap_provider_options: None,
            name: format!("deepwiki-mcp-test-{suffix}"),
            model: AgentModel::from(config.model),
            system,
            description: None,
            tools: vec![
                json!({ "type": "agent_toolset_20260401" }),
                json!({ "type": "mcp_toolset", "mcp_server_name": "deepwiki" }),
            ],
            mcp_servers: vec![json!({
                "type": "url",
                "name": "deepwiki",
                "url": "https://mcp.deepwiki.com/mcp"
            })],
            env_vars: None,
            workspace: None,
            metadata: None,
        })
        .await
        .map_err(|e| format!("[{label}] create agent: {e}"))?;
    eprintln!("[{label}] agent_id={}", agent.id);
    Ok(agent.id)
}

async fn setup_deepwiki_session(
    config: &ProviderConfig,
    label: &str,
    suffix: u64,
) -> Result<String, Box<dyn Error>> {
    eprintln!("[{label}] creating agent");
    let agent_id = create_deepwiki_agent(config, label, suffix).await?;
    let env = config
        .client
        .beta()
        .environments()
        .create(CreateEnvironmentParams {
            lap_agent_runtime: config.runtime,
            name: format!("deepwiki-mcp-env-{suffix}"),
            config: json!({ "type": "cloud", "networking": { "type": "unrestricted" } }),
            description: None,
            scope: None,
        })
        .await
        .map_err(|e| format!("[{label}] create environment: {e}"))?;
    let session = config
        .client
        .beta()
        .sessions()
        .create(CreateSessionParams {
            agent: agent_id,
            environment_id: env.id,
            title: format!("deepwiki-mcp-test-{suffix}"),
            lap_agent_runtime: Some(config.runtime),
            metadata: None,
            vault_ids: None,
            resources: None,
        })
        .await
        .map_err(|e| format!("[{label}] create session: {e}"))?;
    eprintln!("[{label}] session_id={}", session.id);
    Ok(session.id)
}

async fn assert_session_uses_mcp_tool(
    config: &ProviderConfig,
    label: &str,
    session_id: &str,
) -> Result<(), Box<dyn Error>> {
    let mut stream = config
        .client
        .beta()
        .sessions()
        .events()
        .stream(session_id)
        .await
        .map_err(|e| format!("[{label}] open stream: {e}"))?;
    config
        .client
        .beta()
        .sessions()
        .events()
        .send(
            session_id,
            SendEventsParams {
                events: vec![json!({
                    "type": "user.message",
                    "content": [{ "type": "text", "text": "Use deepwiki to get the wiki structure for the anthropics/anthropic-sdk-python repository." }]
                })],
            },
        )
        .await
        .map_err(|e| format!("[{label}] send events: {e}"))?;
    let mut saw_tool_use = false;
    while let Some(event) = stream.next().await {
        let event = event.map_err(|e| format!("[{label}] stream error: {e}"))?;
        eprintln!("[{label}] event: {}", event.event_type);
        match event.event_type.as_str() {
            "agent.mcp_tool_use" | "agent.tool_use" => saw_tool_use = true,
            "session.status_idle" | "session.status_terminated" => break,
            _ => {}
        }
    }
    assert!(
        saw_tool_use,
        "[{label}] expected agent.mcp_tool_use or agent.tool_use"
    );
    Ok(())
}
