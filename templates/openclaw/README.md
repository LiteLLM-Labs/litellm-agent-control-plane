# OpenClaw behind the Anthropic Managed Agents API

This server exposes OpenClaw Gateway through the **Anthropic Managed Agents API
spec**. LAP can drive it as a custom runtime without a new Rust runtime adapter:
register this server as a custom runtime with `api_spec = claude_managed_agents`,
then point `api_base` and `api_key` at this server.

The Docker image installs OpenClaw, writes an OpenClaw model-provider config that
points at the LAP gateway, starts OpenClaw Gateway locally, and starts this
bridge. It also includes Chromium for OpenClaw browser tooling and runs
best-effort browser/memory readiness checks on startup so the first user turn is
less likely to hit missing-browser or stale-memory-index diagnostics. Memory
search defaults to FTS-only mode so the template does not require a separate
embedding API key before it can answer. For local
development you can also run the Python bridge manually against a separately
running OpenClaw Gateway.

OpenClaw remains the owner of agent execution. This template stores LAP
agents/sessions locally, converts LAP session turns into OpenAI-compatible
`/v1/chat/completions` calls, and streams Anthropic-shaped events back to the
control plane.

```text
LAP control plane -> openclaw-agent-server :8080 -> OpenClaw Gateway :18789/v1/chat/completions -> LAP gateway :4000/v1/messages
```

## Quickstart

Start the LAP stack plus OpenClaw:

```bash
docker compose --profile openclaw up
```

The compose profile starts this template with:

- `LITELLM_BASE_URL=http://lap:4000/v1`
- `LITELLM_API_KEY=${LITELLM_MASTER_KEY:-sk-local}`
- `LITELLM_MODELS=${OPENCLAW_MODELS:-claude-sonnet-4-6}`
- `OPENCLAW_AGENT_MODEL=${OPENCLAW_AGENT_MODEL:-litellm/claude-sonnet-4-6}`
- `RUNTIME_API_KEY=${OPENCLAW_RUNTIME_API_KEY:-local-openclaw-key}`

It also registers `local-openclaw` in LAP. Add provider credentials in LAP
Settings before running turns against hosted models.

## Manual Gateway Mode

If you already have OpenClaw running outside this container, start OpenClaw with
its OpenAI-compatible HTTP surface enabled:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true }
      }
    }
  }
}
```

Configure OpenClaw to route backend model calls through the LAP gateway:

```json5
{
  agents: {
    defaults: {
      model: { primary: "litellm/claude-sonnet-4-6" }
    }
  },
  models: {
    providers: {
      litellm: {
        baseUrl: "http://127.0.0.1:4000/v1",
        apiKey: "sk-local",
        auth: "api-key",
        api: "anthropic-messages",
        request: { allowPrivateNetwork: true },
        models: [
          {
            id: "claude-sonnet-4-6",
            name: "claude-sonnet-4-6",
            api: "anthropic-messages",
            contextWindow: 200000,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

Then run only the bridge:

```bash
cd templates/openclaw
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

OPENCLAW_BASE_URL=http://127.0.0.1:18789/v1 \
OPENCLAW_API_KEY="$OPENCLAW_GATEWAY_TOKEN" \
RUNTIME_API_KEY=local-runtime-key \
DB_PATH=/tmp/openclaw.db \
PORT=8080 \
uvicorn src.server:app --host 0.0.0.0 --port 8080
```

In another shell:

```bash
BASE=http://localhost:8080 \
RUNTIME_API_KEY=local-runtime-key \
MODEL=openclaw/default \
./scripts/smoke.sh
```

## LAP Registration

Register the running server in LAP as a custom runtime:

```json
{
  "alias": "openclaw",
  "api_spec": "claude_managed_agents",
  "api_base": "http://localhost:8080",
  "api_key": "local-runtime-key"
}
```

The alias is what agents and sessions store as `runtime`. The API spec tells
LAP to use the existing Claude Managed Agents protocol when talking to this
server.

## Model Routing

OpenClaw treats the OpenAI `model` field as an agent target. This bridge follows
that contract:

- `model: "openclaw/default"` routes to the configured default OpenClaw agent.
- `model: "openclaw/<agentId>"` routes to a specific OpenClaw agent.
- Any other model, such as `litellm/claude-sonnet-4-6`, uses `model: "openclaw/default"`
  and sends the requested backend model as `x-openclaw-model`.

The bridge also sends `x-openclaw-session-key` with the LAP session ID so
OpenClaw can keep state across turns.

## API Surface

The server implements the subset LAP needs:

- `GET /health`
- `GET /v1/models`
- `POST /v1/agents`
- `GET /v1/agents`
- `GET /v1/agents/{id}`
- `PATCH /v1/agents/{id}`
- `POST /v1/environments`
- `POST /v1/sessions`
- `POST /v1/sessions/{id}/events`
- `GET /v1/sessions/{id}/events`
- `GET /v1/sessions/{id}/events/stream`
- `POST /v1/sessions/{id}/abort`

`POST /v1/sessions/{id}/events` also accepts a `user.interrupt` event and maps
it to the same abort handling used by LAP's interrupt flow.

The stream emits Anthropic-shaped event frames:

- `user.message`
- `session.status_running`
- `agent.message`
- `agent.tool_use`
- `session.status_idle`
- `session.error`

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `/data/agents.db` | SQLite persistence path |
| `DEFAULT_MODEL` | `openclaw/default` | OpenClaw agent target used when agent creation omits one |
| `OPENCLAW_BASE_URL` | `http://127.0.0.1:18789/v1` | OpenClaw Gateway OpenAI-compatible base URL |
| `OPENCLAW_API_KEY` | none | Gateway bearer token/password for OpenClaw HTTP auth |
| `OPENCLAW_GATEWAY_TOKEN` | none | Fallback if `OPENCLAW_API_KEY` is unset |
| `OPENCLAW_GATEWAY_PASSWORD` | none | Fallback if token env vars are unset |
| `OPENCLAW_REQUEST_TIMEOUT_SECONDS` | `600` | Per-turn OpenClaw request timeout |
| `RUNTIME_API_KEY` | none | Runtime key expected from LAP via `x-api-key`; when unset, any non-empty key is accepted for local development |
| `LITELLM_BASE_URL` | `http://127.0.0.1:4000/v1` | LAP gateway base URL written into OpenClaw config by the Docker entrypoint |
| `LITELLM_API_KEY` | none | LAP gateway key written into OpenClaw config by the Docker entrypoint |
| `LITELLM_MODELS` | `claude-sonnet-4-6` | Comma-separated model IDs registered under the OpenClaw `litellm` provider |
| `LITELLM_PROVIDER_API` | `anthropic-messages` | OpenClaw provider adapter for LAP model calls |
| `OPENCLAW_AGENT_MODEL` | `litellm/claude-sonnet-4-6` | Default OpenClaw backend model |
| `OPENCLAW_MEMORY_PROVIDER` | `none` | OpenClaw memory-search embedding provider; `none` keeps memory FTS-only and avoids requiring embedding credentials |
| `OPENCLAW_MEMORY_MODEL` | none | Optional memory embedding model when using a non-`none` provider |
| `OPENCLAW_SEED_RUNTIME_MEMORY` | `1` | Seed a small `MEMORY.md` with runtime context when the workspace has none |
| `OPENCLAW_BROWSER_ON_BOOT` | `1` | Start/check OpenClaw's Chromium browser integration during container startup; set `0` to skip |
| `OPENCLAW_BROWSER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Chromium path written into OpenClaw browser config |
| `OPENCLAW_BROWSER_HEADLESS` | `1` | Launch managed Chromium in headless mode |
| `OPENCLAW_BROWSER_NO_SANDBOX` | `1` | Add Chromium `--no-sandbox`, required for the root Docker runtime |
| `OPENCLAW_BROWSER_ALLOW_PRIVATE_NETWORK` | `1` | Allow browser access to private-network hosts for local control-plane testing; set `0` for stricter deployments |
| `OPENCLAW_BROWSER_LAUNCH_TIMEOUT_MS` | `30000` | Max wait for managed Chromium to expose CDP |
| `OPENCLAW_BROWSER_CDP_READY_TIMEOUT_MS` | `30000` | Max wait for CDP readiness after Chromium starts |
| `OPENCLAW_MEMORY_INDEX_ON_BOOT` | `1` | Run best-effort memory status repair and reindex during container startup; set `0` to skip |
| `OPENCLAW_BOOT_TASK_TIMEOUT_SECONDS` | `30` | Max seconds for each best-effort OpenClaw boot task |

## Docker

```bash
docker build -t openclaw-agent-server .
docker run -p 8080:8080 \
  -e LITELLM_BASE_URL=http://host.docker.internal:4000/v1 \
  -e LITELLM_API_KEY=sk-local \
  -e RUNTIME_API_KEY=local-runtime-key \
  openclaw-agent-server
```

## Notes

This is a bridge template, not a new LAP runtime provider. Keep the
Anthropic Managed Agents API surface stable when changing OpenClaw-specific
behavior.
