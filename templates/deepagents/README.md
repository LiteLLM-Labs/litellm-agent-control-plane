# DeepAgents behind the Anthropic Managed Agents API

This server exposes [LangChain DeepAgents](https://docs.langchain.com/oss/python/deepagents/overview) through the **Anthropic Managed Agents API spec**. LAP can drive it as a custom runtime without a new Rust runtime adapter: register this server as a custom runtime with `api_spec = claude_managed_agents`, then point `api_base` and `api_key` at this server.

DeepAgents is hidden behind the runtime contract. LAP continues using the existing `claude_managed_agents` client path.

## Quickstart

```bash
cd templates/deepagents
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

ANTHROPIC_API_KEY=sk-ant-... \
RUNTIME_API_KEY=local-runtime-key \
DB_PATH=/tmp/deepagents.db \
PORT=8080 \
uvicorn src.server:app --host 0.0.0.0 --port 8080
```

In another shell:

```bash
BASE=http://localhost:8080 \
RUNTIME_API_KEY=local-runtime-key \
MODEL=anthropic:claude-sonnet-4-5 \
./scripts/smoke.sh
```

## LAP Registration

Register the running server in LAP as a custom runtime:

```json
{
  "alias": "deepagents",
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

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `/data/agents.db` | SQLite persistence path |
| `DEFAULT_MODEL` | `anthropic:claude-sonnet-4-5` | Model used when agent creation omits one |
| `ANTHROPIC_API_KEY` | none | Server-side model provider key used by DeepAgents |
| `RUNTIME_API_KEY` | none | Runtime key expected from LAP via `x-api-key`; when unset, any non-empty key is accepted for local development |

Do not put model provider keys in LAP browser-visible config. `ANTHROPIC_API_KEY` belongs in this server's environment.

## Docker

```bash
docker build -t deepagents-agent-server .
docker run -p 8080:8080 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e RUNTIME_API_KEY=local-runtime-key \
  deepagents-agent-server
```

## Notes

This is a bridge template, not a new LAP runtime provider. If you need different DeepAgents behavior, change the bridge server while preserving the Anthropic Managed Agents API surface LAP expects.
