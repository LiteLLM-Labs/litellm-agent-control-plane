# Managed Agent Runtime SDK — API Contract

The SDK exposes a single Anthropic-shaped surface for every runtime (Claude Managed Agents, Cursor, Gemini Antigravity, OpenCode, and any future runtime). Callers use the same four-step flow regardless of which runtime is active. Provider differences are fully encapsulated inside `sdk/providers/<provider>/runtime/`.

Reference shape: [Anthropic Managed Agents API](https://platform.claude.com/docs/en/api/beta/agents/create)

---

## Public flow

```rust
let client = Lap::new(LapConfig::anthropic(api_key));  // or ::cursor / ::gemini_antigravity / ::opencode

let agent   = client.beta().agents().create(params).await?;
let agents  = client.beta().agents().list(params).await?;
let env     = client.beta().environments().create(params).await?;
let session = client.beta().sessions().create(params).await?;

// send a prompt
client.beta().sessions().events().send(session_id, params).await?;

// stream the reply
let stream = client.beta().sessions().events().stream(session_id).await?;
```

The flow is identical for every runtime. No `match runtime` or `if runtime == X` blocks appear in calling code.

---

## Input types

### `CreateAgentParams`

| Field | Type | Notes |
|---|---|---|
| `lap_agent_runtime` | `AgentRuntime` | Required. Selects the runtime adapter. |
| `name` | `String` | Agent display name. |
| `model` | `AgentModel` | `AgentModel::Id("claude-opus-4-8")` or `AgentModel::Config { id, speed }`. |
| `system` | `String` | System prompt. Cursor uses this as `prompt.text`; Gemini sends it as `system_instruction`. |
| `description` | `Option<String>` | Optional description. |
| `tools` | `Vec<Value>` | Tool definitions. Cursor ignores this field. Gemini accepts `code_execution`, `google_search`, and `url_context`. |
| `mcp_servers` | `Vec<Value>` | MCP server configs. Cursor maps these to `mcpServers`. |
| `workspace` | `Option<AgentWorkspace>` | Repository + PR intent. Cursor maps to `repos`/`autoCreatePR`; Gemini maps the repository to `base_environment.sources`. |
| `env_vars` | `Option<HashMap<String, String>>` | Runtime environment variables. Reserved for future vault support. |
| `metadata` | `Option<HashMap<String, String>>` | Stored in provider metadata. Anthropic includes it; Cursor ignores. |

### `AgentWorkspace`

| Field | Type | Notes |
|---|---|---|
| `repository` | `String` | Repository URL. |
| `ref_name` | `Option<String>` | Branch or commit ref. Defaults to `"main"`. |
| `auto_create_pr` | `bool` | Whether to open a PR when the run completes. |

### `CreateEnvironmentParams`

| Field | Type | Notes |
|---|---|---|
| `lap_agent_runtime` | `AgentRuntime` | Required. |
| `name` | `String` | Environment name. Cursor returns this as the synthetic environment ID. |
| `config` | `Value` | Anthropic environment config (`{ "type": "cloud", "networking": {...} }`). Cursor ignores. |
| `description` | `Option<String>` | |
| `scope` | `Option<String>` | |

### `CreateSessionParams`

| Field | Type | Notes |
|---|---|---|
| `agent` | `String` | Agent ID from `agents.create`. |
| `environment_id` | `String` | Environment ID from `environments.create`. |
| `title` | `String` | Session title. |
| `lap_agent_runtime` | `Option<AgentRuntime>` | Inferred from client config if only one runtime is configured. |
| `metadata` | `Option<HashMap<String, String>>` | Anthropic stores; Cursor ignores. |
| `resources` | `Option<Value>` | Reserved. |

### `SendEventsParams`

```json
{
  "events": [
    {
      "type": "user.message",
      "content": [{ "type": "text", "text": "..." }]
    }
  ]
}
```

### Agent CRUD

Gemini Antigravity additionally supports saved-agent management through the normalized `agents` resource:

```rust
client.beta().agents().list(ListAgentsParams { ... }).await?;
client.beta().agents().get(GetAgentParams { ... }).await?;
client.beta().agents().delete(DeleteAgentParams { ... }).await?;
```

---

## Output types

### `ManagedAgent`

Anthropic-shaped. All fields extracted from the raw response where available.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | Provider agent ID. Always present. |
| `version` | `Option<u64>` | Anthropic only. |
| `name` | `Option<String>` | |
| `description` | `Option<String>` | |
| `model` | `Option<String>` | Model ID string. |
| `system` | `Option<String>` | |
| `tools` | `Vec<Value>` | |
| `mcp_servers` | `Vec<Value>` | |
| `metadata` | `Option<Value>` | |
| `created_at` | `Option<i64>` | Unix timestamp. |
| `updated_at` | `Option<i64>` | Unix timestamp. |
| `raw` | `Value` | Full unmodified provider response. Escape hatch. |

### `Environment`

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | Provider environment ID. Always present. |
| `raw` | `Value` | Full provider response. Cursor returns `{ "id": "<name>" }`. |

### `Session`

Anthropic-shaped.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | Provider session ID. Always present. |
| `agent` | `Option<String>` | Agent ID. |
| `environment_id` | `Option<String>` | Environment ID. |
| `status` | `Option<String>` | Session status string. |
| `metadata` | `Option<Value>` | |
| `created_at` | `Option<i64>` | Unix timestamp. |
| `updated_at` | `Option<i64>` | Unix timestamp. |
| `raw` | `Value` | Full provider response. |

### `AgentEvent`

Anthropic-shaped. Cursor events are normalized to this shape by the cursor adapter before the stream is returned to the caller.

| Field | Type | Notes |
|---|---|---|
| `event_type` | `String` | Anthropic event type string (e.g. `"agent.message"`, `"session.status_idle"`). |
| `data` | `Map<String, Value>` | Event payload. |

Use `event.kind()` → `AgentEventKind` and `event.payload()` → `AgentEventPayload` for typed access.

Key event types:

| Event | Meaning |
|---|---|
| `session.status_running` | Session is processing. |
| `agent.message` | Assistant reply. `data.content` is an array of content blocks. |
| `agent.tool_use` | Agent called a tool. |
| `agent.tool_result` | Tool returned a result. |
| `session.status_idle` | Session is done. Terminal event — stop reading the stream. |

---

## Provider normalization

Each runtime maps its native response shape to the Anthropic-shaped outputs above. Callers never see provider-specific fields unless they inspect `.raw`.

| Concern | Anthropic | Cursor | Gemini Antigravity | OpenCode |
|---|---|---|---|---|
| `agents.create` HTTP path | `POST /v1/agents` | `POST /v1/agents` | `POST /v1beta/agents` | Not supported |
| Agent CRUD | Create only | Create only | Create, list, get, delete | Not supported |
| `environments.create` | `POST /v1/environments` | Synthetic (`{ id: name }`) | Synthetic (`remote` or supplied ID) | Not supported |
| `sessions.create` | `POST /v1/sessions` | Synthetic (uses agent ID) | Synthetic conversation handle | `POST /session` |
| `send_events` | `POST /v1/sessions/{id}/events` | `POST /v1/agents/{id}/runs` | `POST /v1beta/interactions` | `POST /session/{id}/chat` |
| `stream_events` | `GET /v1/sessions/{id}/events/stream` | `GET /v1/agents/{id}/runs/{run_id}/stream` | `GET /v1beta/interactions/{id}` | `GET /session/{id}/events` |
| Event normalization | Native Anthropic SSE | Cursor events -> Anthropic shape | Interaction steps -> Anthropic shape | Native |
| Initial run on create | No — send first prompt via `send_events` | Yes — `agents.create` starts a run immediately | No — send first prompt via `send_events` | No |

---

## Adapter contract

Each runtime implements `RuntimeAdapter` in `sdk/providers/<runtime>/runtime/mod.rs`. Required methods:

```rust
fn configure_request(&self, request: RequestBuilder, api_key: &str) -> RequestBuilder;
fn create_agent<'a>(&'a self, client: &'a Lap, params: CreateAgentParams) -> AdapterFuture<'a, ManagedAgent>;
fn create_environment<'a>(...) -> AdapterFuture<'a, Environment>;
fn create_session<'a>(...) -> AdapterFuture<'a, Session>;
fn send_events<'a>(...) -> AdapterFuture<'a, SendEventsResponse>;
fn stream_events<'a>(...) -> AdapterFuture<'a, AgentEventStream>;
```

Optional overrides (default: `None`):

```rust
fn normalize_stream(&self, stream: AgentEventStream) -> AgentEventStream;
fn provider_run_id_from_agent_raw(&self, raw: &Value) -> Option<String>;
fn provider_url_from_agent_raw(&self, raw: &Value) -> Option<String>;
fn provider_agent_id_from_session_id(&self, session_id: &str) -> Option<String>;
```

To add a new runtime: create `sdk/providers/<name>/runtime/mod.rs`, implement `RuntimeAdapter`, add `RUNTIME_ID`/`RUNTIME_NAME`/`DEFAULT_API_BASE` constants, and call `registry.register(...)` in the provider's `mod.rs`. No other files change.
