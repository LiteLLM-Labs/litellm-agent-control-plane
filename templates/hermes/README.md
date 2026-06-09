# Hermes Agent behind the Anthropic Managed Agents API

This server exposes [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent) through the **Anthropic Managed Agents API spec**. LAP can drive it as a custom runtime without a new Rust runtime adapter: register this server as a custom runtime with `api_spec = claude_managed_agents`, then point `api_base` and `api_key` at this server.

Hermes is hidden behind the runtime contract. Model calls route back through LAP's `/v1/messages` endpoint, so provider credentials stay on LAP.

## Quickstart

```bash
cd templates/hermes
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

# Install Hermes separately for local development:
#   git clone https://github.com/NousResearch/hermes-agent /tmp/hermes-agent
#   python -m pip install -e "/tmp/hermes-agent[anthropic,cli,mcp]"

LAP_BASE_URL=http://localhost:4000 \
LAP_API_KEY=sk-local \
RUNTIME_API_KEY=local-runtime-key \
DB_PATH=/tmp/hermes.db \
HERMES_HOME_ROOT=/tmp/hermes-home \
HERMES_WORKDIR=/tmp/hermes-workspace \
PORT=8080 \
uvicorn src.server:app --host 0.0.0.0 --port 8080
```

In another shell:

```bash
BASE=http://localhost:8080 \
RUNTIME_API_KEY=local-runtime-key \
MODEL=anthropic/claude-sonnet-4-5 \
./scripts/smoke.sh
```

## LAP Registration

Register the running server in LAP as a custom runtime:

```json
{
  "alias": "hermes",
  "api_spec": "claude_managed_agents",
  "api_base": "http://localhost:8080",
  "api_key": "local-runtime-key"
}
```

The alias is what agents and sessions store as `runtime`. The API spec tells LAP to use the existing Claude Managed Agents protocol when talking to this server.

## API Surface

The server implements the subset LAP needs:

- `GET /health`
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
- `session.status_idle`
- `session.error`

Hermes tool execution happens inside the Hermes CLI process. This bridge emits the final Hermes turn as an `agent.message`; it does not currently decompose Hermes' terminal output into individual `agent.tool_use` and `agent.tool_result` frames.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `/data/agents.db` | SQLite persistence path |
| `DEFAULT_MODEL` | `anthropic/claude-sonnet-4-5` | Model used when agent creation omits one |
| `LAP_BASE_URL` | none | LAP gateway root URL; Hermes calls `{LAP_BASE_URL}/v1/messages` through its Anthropic Messages transport |
| `LAP_API_KEY` | none | LAP gateway key used only to authenticate to LAP |
| `RUNTIME_API_KEY` | none | Runtime key expected from LAP via `x-api-key`; when unset, any non-empty key is accepted for local development |
| `HERMES_COMMAND` | `hermes` | Hermes CLI command path |
| `HERMES_HOME_ROOT` | `/data/hermes-home` | Parent directory for per-session Hermes homes |
| `HERMES_WORKDIR` | `/tmp/hermes-workspace` | Parent directory for per-session workspaces |
| `HERMES_TOOLSETS` | `terminal,web` | Hermes toolsets enabled for each turn |
| `HERMES_MAX_TURNS` | `20` | Max Hermes tool-calling iterations |
| `HERMES_TIMEOUT_SECONDS` | `300` | Subprocess timeout per prompt |

Do not put model provider keys on this server. Anthropic/OpenAI/etc. credentials belong on LAP; this bridge only needs LAP routing coordinates.

## Docker

```bash
docker build -t hermes-agent-server .
docker run -p 8080:8080 \
  -e LAP_BASE_URL=http://host.docker.internal:4000 \
  -e LAP_API_KEY=sk-local \
  -e RUNTIME_API_KEY=local-runtime-key \
  hermes-agent-server
```

## Notes

This is a bridge template, not a new LAP runtime provider. If you need different Hermes behavior, change the bridge server while preserving the Anthropic Managed Agents API surface LAP expects.
