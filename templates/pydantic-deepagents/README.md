# Pydantic Deep Agents behind the Anthropic Managed Agents API

This server exposes [Pydantic Deep Agents](https://github.com/vstorm-co/pydantic-deepagents) through the **Anthropic Managed Agents API spec**. LAP can drive it as a custom runtime without a new Rust adapter: register this server as a custom runtime with `api_spec = claude_managed_agents`, then point `api_base` and `api_key` at this server.

The bridge stores LAP agents, environments, sessions, and event history in SQLite. Each session gets its own Pydantic Deep `LocalBackend` workspace under `PYDANTIC_DEEP_WORKDIR_ROOT`.

## Quickstart

```bash
cd templates/pydantic-deepagents
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

ANTHROPIC_API_KEY=sk-ant-... \
RUNTIME_API_KEY=local-runtime-key \
DB_PATH=/tmp/pydantic-deepagents.db \
PYDANTIC_DEEP_WORKDIR_ROOT=/tmp/pydantic-deepagents-workspaces \
PORT=8080 \
uvicorn src.server:app --host 0.0.0.0 --port 8080
```

In another shell:

```bash
BASE=http://localhost:8080 \
RUNTIME_API_KEY=local-runtime-key \
MODEL=anthropic:claude-sonnet-4-6 \
./scripts/smoke.sh
```

## Deterministic Local Tests

Pydantic AI includes a built-in `test` model that emits tool calls without a
provider API key. Use it to verify the bridge and MCP plumbing locally:

```bash
cd templates/pydantic-deepagents
. .venv/bin/activate

RUNTIME_API_KEY=local-runtime-key \
DB_PATH=/tmp/pydantic-deepagents-test.db \
PYDANTIC_DEEP_WORKDIR_ROOT=/tmp/pydantic-deepagents-test-workspaces \
PYDANTIC_DEEP_TODO=false \
PYDANTIC_DEEP_FILESYSTEM=false \
PYDANTIC_DEEP_SUBAGENTS=false \
PYDANTIC_DEEP_SKILLS=false \
PYDANTIC_DEEP_MEMORY=false \
PYDANTIC_DEEP_WEB_SEARCH=false \
PYDANTIC_DEEP_WEB_FETCH=false \
PYDANTIC_DEEP_CONTEXT_MANAGER=false \
PYDANTIC_DEEP_COST_TRACKING=false \
uvicorn src.server:app --host 0.0.0.0 --port 8080
```

Then run the DeepWiki MCP smoke:

```bash
BASE=http://localhost:8080 \
RUNTIME_API_KEY=local-runtime-key \
MODEL=test \
./scripts/mcp-smoke.sh
```

The MCP smoke creates an agent with `https://mcp.deepwiki.com/mcp`, sends a
managed-agent event, and asserts the SSE stream contains `agent.tool_use`,
`agent.tool_result`, `agent.message`, and `session.status_idle`.

## LiteLLM Routing

For direct Anthropic usage, set `ANTHROPIC_API_KEY` and use models like `anthropic:claude-sonnet-4-6`.

To route through LiteLLM's OpenAI-compatible API, set:

```bash
LITELLM_BASE_URL=http://localhost:4000
LITELLM_API_KEY=sk-...
LITELLM_MODELS=claude-sonnet-4-6,gpt-4.1
DEFAULT_MODEL=claude-sonnet-4-6
```

When `LITELLM_BASE_URL` is set, bare model names are normalized to `openai:<model>` for Pydantic AI, and `/v1/models` proxies LiteLLM model discovery with a local fallback.

For an Anthropic Messages-compatible gateway, set:

```bash
LITELLM_BASE_URL=https://litellm-rust.onrender.com
LITELLM_API_KEY=sk-...
LITELLM_API_FORMAT=anthropic
DEFAULT_MODEL=claude-sonnet-4-6
```

In this mode, bare model names are normalized to `anthropic:<model>` and the
bridge builds a Pydantic AI `AnthropicModel` pointed at `LITELLM_BASE_URL`. The
Anthropic SDK appends `/v1/messages` when it sends requests.

## LAP Registration

Register the running server in LAP as a custom runtime:

```json
{
  "alias": "pydantic-deepagents",
  "api_spec": "claude_managed_agents",
  "api_base": "http://localhost:8080",
  "api_key": "local-runtime-key"
}
```

The alias is what agents and sessions store as `runtime`. The API spec tells LAP to use the existing Claude Managed Agents protocol when talking to this server.

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

The stream emits Anthropic-shaped event frames:

- `session.status_running`
- `agent.message`
- `agent.tool_use`
- `agent.tool_result`
- `session.status_idle`
- `session.error`

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `/data/agents.db` | SQLite persistence path |
| `PYDANTIC_DEEP_WORKDIR_ROOT` | `/data/workspaces` | Root directory for per-session workspaces |
| `DEFAULT_MODEL` | `anthropic:claude-sonnet-4-6` | Model used when agent creation omits one |
| `ANTHROPIC_API_KEY` | none | Direct Anthropic provider key |
| `OPENAI_API_KEY` | none | Direct OpenAI provider key |
| `OPENAI_BASE_URL` | none | OpenAI-compatible base URL |
| `LITELLM_BASE_URL` | none | LiteLLM gateway base URL for model discovery and OpenAI-compatible routing |
| `LITELLM_API_KEY` | none | LiteLLM gateway API key |
| `LITELLM_API_FORMAT` | `openai` | Gateway API shape: `openai` for `/v1/chat/completions`, `anthropic` for `/v1/messages` |
| `LITELLM_MODELS` | none | Comma-separated fallback model IDs for `/v1/models` |
| `RUNTIME_API_KEY` | none | Runtime key expected from LAP via `x-api-key`; when unset, any non-empty key is accepted for local development |
| `PYDANTIC_DEEP_EXECUTE` | `true` | Enables the Pydantic Deep execute tool |
| `PYDANTIC_DEEP_TODO` | `true` | Enables todo tools |
| `PYDANTIC_DEEP_FILESYSTEM` | `true` | Enables filesystem tools |
| `PYDANTIC_DEEP_SUBAGENTS` | `true` | Enables subagent tools |
| `PYDANTIC_DEEP_SKILLS` | `true` | Enables skill tools |
| `PYDANTIC_DEEP_MEMORY` | `true` | Enables persistent memory tools |
| `PYDANTIC_DEEP_WEB_SEARCH` | `true` | Enables web search tools |
| `PYDANTIC_DEEP_WEB_FETCH` | `true` | Enables web fetch tools |
| `PYDANTIC_DEEP_THINKING` | `false` in Anthropic gateway mode, otherwise `high` | Enables Pydantic Deep thinking effort; use `false`, `true`, or an effort like `low`, `medium`, `high` |
| `PYDANTIC_DEEP_CONTEXT_MANAGER` | `true` | Enables context management |
| `PYDANTIC_DEEP_COST_TRACKING` | `true` | Enables cost tracking |
| `PYDANTIC_DEEP_FORKING` | `false` | Enables live run forking tools |
| `PYDANTIC_DEEP_CHECKPOINTS` | `false` | Enables checkpoint tools |
| `PYDANTIC_DEEP_TEAMS` | `false` | Enables team tools |
| `PYDANTIC_DEEP_LITEPARSE` | `false` | Enables LiteParse document tools |

Do not put model provider keys in LAP browser-visible config. Provider keys belong in this server's environment.

## Docker

```bash
docker build -t pydantic-deepagents-agent-server .
docker run -p 8080:8080 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e RUNTIME_API_KEY=local-runtime-key \
  pydantic-deepagents-agent-server
```

## Notes

This is a bridge template, not a new LAP runtime provider. If you need different Pydantic Deep behavior, change the bridge server while preserving the Anthropic Managed Agents API surface LAP expects.
