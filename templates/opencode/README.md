# opencode Managed Agents server

Run this wrapper next to an [opencode](https://opencode.ai) install. It exposes
opencode through the Anthropic Managed Agents API so LiteLLM Agent Platform
(LAP) can use it as a `claude_managed_agents` runtime.

```text
LAP -> opencode-agent-server :8080 -> opencode serve :4096
```

## Quick Start

> **Important**
>
> This server starts `opencode serve` itself. Run it on the same machine where
> the `opencode` CLI is installed, or use Docker, which installs opencode inside
> the image for you.
>
> When using Docker, mount both `/data` and `/tmp/opencode-workspace` so the
> SQLite DB and generated opencode config survive restarts.

### Run with Docker

```bash
cd templates/opencode
docker build -t opencode-agent-server .
docker run --rm -p 8080:8080 \
  -v opencode-agent-data:/data \
  -v opencode-workspace:/tmp/opencode-workspace \
  -e LITELLM_BASE_URL=https://your-litellm-gateway/v1 \
  -e LITELLM_API_KEY=sk-... \
  -e LITELLM_MODELS=claude-sonnet-4-6 \
  opencode-agent-server
```

For a direct Anthropic key, use this environment line instead of the three
LiteLLM lines:

```bash
  -e ANTHROPIC_API_KEY=sk-ant-... \
```

Health check:

```bash
curl http://localhost:8080/health
# {"ok":true,"opencode":true}
```

If `opencode` is `false`, wait a few seconds and retry. The wrapper binds port
8080 first, then starts opencode in the background.

## Connect from LAP

In LAP, open **AI Gateway** > **Agent Runtimes** > **Add Runtime** and use:

| Field | Value |
|-------|-------|
| Alias | `opencode-local` |
| API Spec | `claude_managed_agents` |
| API Base | `http://localhost:8080` if LAP is on the same machine; `http://YOUR_SERVER_HOST:8080` or your HTTPS URL if LAP is elsewhere |
| API Key | Any non-empty placeholder, for example `fake-opencode-key` |

The server accepts Anthropic-style headers but does not validate the inbound API
key. LAP still needs a value so it can store the runtime credential.

After adding the runtime, select `opencode-local` in a LAP session and use a
model from `LITELLM_MODELS`, such as `claude-sonnet-4-6`.

## Per-agent model selection

`model` is a **string** in the route contract. Create an agent with the model
you want and every turn in its sessions runs on that model:

```json
POST /v1/agents
{
  "name": "Agent",
  "model": "gpt-5.5",
  "system": "..."
}
```

The model string is stored on the agent and returned from `GET /v1/agents/:id`.

For LiteLLM-backed deployments, a bare name like `gpt-5.5` is normalized to
opencode's provider/model object `{ "providerID": "litellm", "modelID": "gpt-5.5" }`,
and the model is registered in the generated `opencode.json` before opencode
reboots. Pass `litellm/gpt-5.5` to set the provider/model split explicitly. The
target model must be in `LITELLM_MODELS` (or otherwise routable by your
configured LiteLLM gateway).

> The object form `{ "id": "gpt-5.5" }` is still accepted for backward
> compatibility, but the string form is the documented API.

Smoke-test a specific model end to end:

```bash
BASE=http://localhost:8080 MODEL=gpt-5.5 ./scripts/smoke.sh
```

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8080` | listen port |
| `OPENCODE_PORT` | `4096` | internal `opencode serve` port |
| `WORKDIR` | `/tmp/opencode-workspace` | per-agent config directory |
| `DB_PATH` | `/data/agents.db` | SQLite agent store |
| `ANTHROPIC_API_KEY` | — | native Anthropic key (alternative to LiteLLM) |
| `LITELLM_BASE_URL` | — | LiteLLM gateway base URL (include `/v1`) |
| `LITELLM_API_KEY` | — | LiteLLM gateway key |
| `LITELLM_MODELS` | `claude-sonnet-4-6` | comma-separated models to register |
| `OPENSANDBOX_API_URL` | — | OpenSandbox controller URL (enables sandboxed execution) |
| `OPENSANDBOX_API_KEY` | — | OpenSandbox API key |
| `OPENSANDBOX_IMAGE` | — | sandbox execd image |

## Deploy on EKS with OpenSandbox

For a production deployment of opencode-anthropic-server + OpenSandbox on EKS,
see [`docs/eks-deployment.md`](docs/eks-deployment.md).
