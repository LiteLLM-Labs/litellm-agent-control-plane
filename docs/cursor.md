# Cursor Managed Agent Runtime

The Agent Runtime SDK exposes Cursor through the same Anthropic-shaped beta
surface used for Claude Managed Agents. Configure Cursor by setting a Cursor
runtime key, then select `AgentRuntime::Cursor` when creating the agent.

```rust
use litellm_rust::sdk::agents::{
    AgentModel, AgentRuntime, CreateAgentParams, CreateSessionParams, Lap, LapConfig,
    SendEventsParams,
};
use serde_json::json;

let client = Lap::new(LapConfig::cursor("cursor-api-key"));

let agent = client
    .beta()
    .agents()
    .create(CreateAgentParams {
        lap_agent_runtime: AgentRuntime::Cursor,
        lap_provider_options: None,
        name: "Coding Assistant".to_owned(),
        model: AgentModel::from("composer-2"),
        system: "Fix the failing tests.".to_owned(),
        description: None,
        tools: Vec::new(),
        mcp_servers: Vec::new(),
    })
    .await?;

let session = client
    .beta()
    .sessions()
    .create(CreateSessionParams {
        agent: agent.id,
        environment_id: "cursor".to_owned(),
        title: "Cursor session".to_owned(),
        lap_agent_runtime: Some(AgentRuntime::Cursor),
        metadata: None,
        resources: None,
    })
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
                    "text": "Add a regression test."
                }]
            })],
        },
    )
    .await?;

let mut stream = client.beta().sessions().events().stream(&session.id).await?;
```

## Gateway Stream

For LAP-managed sessions backed by the database, the gateway registers the
local session id with the SDK and exposes normalized events at:

```text
GET /v1/sessions/{session_id}/events/stream
```

Authenticate with the configured master key using `Authorization: Bearer ...`
or `?key=...`.

Cursor runtime session creation translates repository and PR preferences from
the session `environment` into Cursor `repos` and `autoCreatePR` fields:

```json
{
  "runtime": "cursor",
  "agent_id": "agent_...",
  "prompt": "Fix the failing tests",
  "environment": {
    "model": "composer-2",
    "repository": "https://github.com/acme/app",
    "ref": "main",
    "auto_create_pr": true
  }
}
```

## Event Shape

Cursor emits chunked run events such as `assistant`, `tool_call`, `status`, and
`result`. The SDK rewrites those to the Anthropic Managed Agents event surface:

```text
session.status_running
agent.message
agent.tool_use
agent.tool_result
session.status_idle
session.error
```

Cursor-specific event names are not exposed through the public SDK stream.
