# Architecture

litellm-rust is a low-overhead gateway. A request flows through four layers:

```
                    ┌─────────────────────────────────────────────┐
  POST /v1/messages │  litellm-rust                                │
  ────────────────► │                                             │
                    │  endpoint ─► router ─► transformation ─► llm │ ──► provider API
  ◄──────────────── │                                             │ ◄──
       response     └─────────────────────────────────────────────┘
```

| Layer | File | Responsibility |
|---|---|---|
| **Endpoint** | `http/messages.rs` | Receive the request, authenticate (master key) |
| **Router** | `sdk/routing.rs` | Map the public model name to an upstream deployment + provider handler |
| **Transformation** | `sdk/providers/<name>/<endpoint>/transformation.rs` | Translate the request into the provider's API shape |
| **LLM API** | `http/llm.rs` | The only place that does outbound networking |

## Two halves

The code is split so endpoint transformation, runtime SDK, and proxy concerns stay
separate:

| Half | Folders | What it is |
|---|---|---|
| **Routing** | `sdk/routing.rs` | Request/model routing that sits above provider endpoint transformation. |
| **Base transformations** | `sdk/providers/base/` | Shared traits for endpoint families (`anthropic_messages`, `openai_responses`) and runtime adapters. |
| **Provider integrations** | `sdk/providers/<provider>/<endpoint>/` | Provider-owned endpoint translations and runtime adapters. |
| **Agent Runtime SDK** | `sdk/agents/` | The `Lap` client resources and managed-agent runtime types. |
| **Proxy server** | `proxy/`, `http/`, `cli/` | Everything around the transformation: config loading, master-key auth, shared `AppState`, HTTP endpoints, the CLI wizard. |

`errors.rs` (the shared `GatewayError`) sits at the crate root — both halves use
it. The rule: `sdk/routing.rs` and `sdk/providers/` must not depend on
`proxy/`. (One bridge remains: `routing::Router::from_config` reads
`proxy::config::GatewayConfig`; when the SDK is extracted, the proxy will build
the route table and hand routing plain data instead.)

## Request flow

A request like:

```bash
curl http://localhost:4000/v1/messages \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -d '{"model": "claude-opus-4-6", "messages": [...]}'
```

1. **Endpoint** (`http/messages.rs`) — `proxy::auth` checks the `Authorization: Bearer` token against the configured master key, then parses the body and reads `model`.
2. **Router** (`sdk/routing.rs`) — looks up `"claude-opus-4-6"` in the route table built at boot from `config.yaml`. Returns a `Route` = `{ deployment, handler }`.
3. **Transformation** (`sdk/providers/base/anthropic_messages.rs` + `sdk/providers/anthropic/anthropic_messages/transformation.rs`) — rewrites the model alias through the base Anthropic Messages transform, then builds outbound Anthropic headers (`x-api-key`, `anthropic-version`).
4. **LLM API** (`http/llm.rs`) — sends to `https://api.anthropic.com/v1/messages`, streams the response back byte-for-byte.

## Config → routes

Config types, parsing, env expansion, and boot-time validation all live in
`proxy/config.rs`. The route table comes from `config.yaml`:

```yaml
model_list:
  - model_name: claude-opus-4-6           # ← public name, the lookup key
    litellm_params:
      model: anthropic/claude-opus-4-6     # ← provider_id / upstream_model
      api_key: os.environ/ANTHROPIC_API_KEY
```

At boot, each entry becomes a `Deployment`:

```
provider_id:    "anthropic"
upstream_model: "claude-opus-4-6"
api_base:       "https://api.anthropic.com"   # provider default, or api_base override
api_key:        "sk-ant-..."
```

This is what separates the public alias from the real upstream call.

## Config-defined agents

`config.yaml` can also define agents under `agents`, with sandbox selection and
E2B parameters configured under `general_settings`. Config parsing and
validation still flow through `proxy/config.rs`; agent-specific config types
live in `src/agents/config.rs`.

Agent runs are HTTP-triggered and streamed per run:

```bash
POST /api/agents/{agent_id}/run
GET  /events
```

The run endpoint returns `202` with an `event_url`. The `/events` endpoint is
the SSE stream for agent runs and emits `agent.run.started`,
`agent.sandbox.created`, `agent.output.delta`, and terminal run events. Event
payloads include `agent_id` and `run_id` so clients can filter the stream.

Sandbox provisioning is owned by the proxy. The agent does not receive a
sandbox provisioning tool; `src/agents/sandboxes/e2b.rs` creates the E2B
sandbox, starts the Claude Code process, streams process output, and terminates
the sandbox when the run ends.

## Providers are self-contained

Each provider is one folder under `src/sdk/providers/`. `build.rs` scans for any
provider with an `<endpoint>/mod.rs` and wires it into the LLM registry automatically.
Endpoint-family base traits live in `src/sdk/providers/base/`; provider
folders implement them for specific upstreams. Runtime adapters live beside
endpoint translations under the same provider folder.

To add a provider (e.g. OpenAI):

```
src/sdk/providers/openai/
├── mod.rs
└── openai_responses/
    ├── mod.rs              # pub fn init(registry) { registry.register("openai", ...) }
    └── transformation.rs   # impl Transformation
```

That's the whole contract. The router, endpoint, and networking layers never
change.

**Rule:** providers translate protocol shape only. They never make network
calls — all outbound HTTP lives in `http/llm.rs`. This keeps the hot path in one
place and stops each provider from re-implementing (and mis-implementing)
networking.

## Boot sequence

`main.rs` → `serve_gateway`:

1. Load + validate `config.yaml` (`proxy::config::load_config`)
2. Build the `ProviderRegistry` (`register_all`, generated by `build.rs`)
3. Build the `Router` from config + registry
4. Assemble `AppState` (config, router, one shared HTTP client)
5. Start the Axum server

`main.rs` also dispatches the `claude` CLI wizard and `logout` before serving
(see `cli/`).
