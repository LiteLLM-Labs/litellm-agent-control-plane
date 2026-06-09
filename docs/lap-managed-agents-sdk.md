# Managed Agent Runtime SDK

This SDK is a provider-facing Rust client for managed-agent runtimes. The Rust
client type is still named `Lap` for API compatibility. It does not read or
write LAP database state; service code owns DB lookup, idempotency, vaults, and
remote-ID storage.

## Rust Quickstart

```rust
use futures_util::StreamExt;
use litellm_rust::sdk::agents::{
    AgentEventPayload, AgentModel, AgentRuntime, CreateAgentParams, CreateEnvironmentParams,
    CreateSessionParams, Lap, LapConfig, SendEventsParams,
};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Lap::new(LapConfig::anthropic("sk-ant-..."));

    let agent = client
        .beta()
        .agents()
        .create(CreateAgentParams {
            lap_agent_runtime: AgentRuntime::ClaudeManagedAgents,
            lap_provider_options: None,
            name: "Coding Assistant".to_owned(),
            model: AgentModel::from("claude-opus-4-8"),
            system: "You are a helpful coding assistant. Write clean, well-documented code."
                .to_owned(),
            description: None,
            tools: vec![json!({ "type": "agent_toolset_20260401" })],
            mcp_servers: Vec::new(),
            env_vars: None,
            workspace: None,
            metadata: None,
        })
        .await?;

    println!("Agent ID: {}, version: {:?}", agent.id, agent.version);

    let environment = client
        .beta()
        .environments()
        .create(CreateEnvironmentParams {
            lap_agent_runtime: AgentRuntime::ClaudeManagedAgents,
            name: "quickstart-env".to_owned(),
            config: json!({
                "type": "cloud",
                "networking": { "type": "unrestricted" },
            }),
            description: None,
            scope: None,
        })
        .await?;

    println!("Environment ID: {}", environment.id);

    let session = client
        .beta()
        .sessions()
        .create(CreateSessionParams {
            agent: agent.id,
            environment_id: environment.id,
            title: "Quickstart session".to_owned(),
            lap_agent_runtime: None,
            metadata: None,
            vault_ids: None,
            resources: None,
        })
        .await?;

    println!("Session ID: {}", session.id);

    let mut stream = client
        .beta()
        .sessions()
        .events()
        .stream(&session.id)
        .await?;

    client
        .beta()
        .sessions()
        .events()
        .send(
            &session.id,
            SendEventsParams {
                events: vec![json!({
                    "type": "user.message",
                    "content": [{
                        "type": "text",
                        "text": "Create a Python script that generates the first 20 Fibonacci numbers and saves them to fibonacci.txt"
                    }]
                })],
            },
        )
        .await?;

    while let Some(event) = stream.next().await {
        let event = event?;
        match event.payload() {
            AgentEventPayload::AgentMessage(message) => {
                for block in message.content {
                    if let Some(text) = block.get("text").and_then(|value| value.as_str()) {
                        print!("{text}");
                    }
                }
            }
            AgentEventPayload::AgentToolUse(tool) => {
                if let Some(name) = tool.name {
                    println!("\n[Using tool: {name}]");
                }
            }
            AgentEventPayload::SessionStatusIdle(_) => {
                println!("\n\nAgent finished.");
                break;
            }
            AgentEventPayload::SessionError(error) => {
                return Err(format!("session error: {:?}", error.raw).into())
            }
            _ => {}
        }
    }

    Ok(())
}
```

## Contract

- `LapConfig::anthropic(...)` configures the `claude_managed_agents` runtime.
- `LapConfig::cursor(...)` configures the `cursor` runtime.
- `LapConfig::gemini_antigravity(...)` configures the `gemini_antigravity` runtime.
- `LapConfig::opencode(...)` configures the `opencode` runtime.
- Gateway and UI runtime configuration uses `claude_agents`; the SDK runtime id
  remains `claude_managed_agents`.
- `lap_agent_runtime` selects the runtime.
- `lap_provider_options` is reserved for LAP gateway adapters that must carry
  provider-specific fields such as Cursor `repos` and `autoCreatePR`.
- `agent.id`, `environment.id`, and `session.id` are provider/runtime IDs.
- The SDK forwards Anthropic-shaped payloads to the runtime provider.
- Cursor requests are translated to Cursor's v1 Cloud Agent APIs.
- The SDK sets the Managed Agents beta header and parses SSE session events.
- Cursor stream chunks are normalized to Anthropic Managed Agents event shape.
- `AgentEvent` keeps the flat JSON event shape and adds typed views through
  `kind()` and `payload()`.
- Runtime-specific behavior is isolated behind provider-owned adapters under
  `src/sdk/providers/<provider>/runtime/`.
- The gateway exposes the same normalized stream at `/v1/sessions/{session_id}/events/stream`.
  The route requires the configured master key in `Authorization: Bearer ...` or `?key=...`.
- The SDK does not perform DB calls, idempotency checks, or vault operations.

## Supported Surface

```rust
client.beta().agents().create(...)
client.beta().agents().list(...)
client.beta().agents().get(...)
client.beta().agents().delete(...)
client.beta().environments().create(...)
client.beta().sessions().create(...)
client.beta().sessions().events().send(...)
client.beta().sessions().events().stream(...)
```

Implemented runtimes:

```text
claude_managed_agents
cursor
gemini_antigravity
opencode
```

## Possible Python Wrapper

This wrapper is not a shipped public API. Python bindings can wrap this Rust
client and preserve the Anthropic-like shape:


```python
from lap import LAP

client = LAP(anthropic_api_key="sk-ant-...")

agent = client.beta.agents.create(
    lap_agent_runtime="claude_managed_agents",
    name="Coding Assistant",
    model="claude-opus-4-8",
    system="You are a helpful coding assistant.",
    tools=[{"type": "agent_toolset_20260401"}],
)
```

The Python API is sugar over the Rust SDK contract, not the source of truth.
