# Devin Managed Agents server

Run this wrapper next to a [Devin CLI](https://devin.ai/cli) install. It exposes
Devin through the Anthropic Managed Agents API so LiteLLM Agent Platform (LAP)
can use it as a `claude_managed_agents` runtime.

```text
LAP -> devin-agent-server :8080 -> devin acp (ACP over stdio)
```

The server spawns a single `devin acp` child process and drives it as an
[Agent Client Protocol](https://agentclientprotocol.com/) client (JSON-RPC over
stdio). It translates the Anthropic Managed Agents API into ACP
`session/new` / `session/prompt` calls and translates ACP `session/update`
notifications back into Anthropic SSE event shapes.

## Quick Start

> **Important**
>
> Devin CLI must be installed and authenticated on the server host. Install it
> with `curl -fsSL https://cli.devin.ai/install.sh | bash`, then run
> `devin auth login`. That's the only auth step — `devin acp` reads the host's
> stored credentials, so this server never asks you for a Devin API key. (If
> you prefer, `WINDSURF_API_KEY` is honoured as an alternative to `auth login`.)
>
> Unlike the opencode template, Devin routes model calls through your Devin
> account — there is no `LITELLM_BASE_URL` wiring. Models are addressed by
> Devin's fuzzy family names (`opus`, `sonnet`, `swe`, `gpt`, `gemini`) or
> `adaptive`.

### Run with Docker

The image installs the Devin CLI for you. To give it credentials, either set
`WINDSURF_API_KEY` or mount the host's Devin config dir (where `auth login`
stored its token):

```bash
cd templates/devin
docker build -t devin-agent-server .
# Option A: mount the host's Devin credentials (created by `devin auth login`)
docker run --rm -p 8080:8080 \
  -v devin-agent-data:/data \
  -v devin-workspace:/tmp/devin-workspace \
  -v ~/.config/devin:/root/.config/devin:ro \
  devin-agent-server
# Option B: pass WINDSURF_API_KEY
docker run --rm -p 8080:8080 \
  -v devin-agent-data:/data \
  -v devin-workspace:/tmp/devin-workspace \
  -e WINDSURF_API_KEY=... \
  devin-agent-server
```

Health check:

```bash
curl http://localhost:8080/health
# {"ok":true,"devin":true}
```

If `devin` is `false`, wait a few seconds and retry. The wrapper binds port
8080 first, then starts `devin acp` in the background.

### Run locally (no Docker)

```bash
cd templates/devin
npm install
node src/index.mjs   # uses the credentials from `devin auth login`
```

## Connect from LAP

In LAP, open **AI Gateway** > **Agent Runtimes** > **Add Runtime** and use:

| Field | Value |
|-------|-------|
| Alias | `devin-local` |
| API Spec | `claude_managed_agents` |
| API Base | `http://localhost:8080` if LAP is on the same machine; `http://YOUR_SERVER_HOST:8080` or your HTTPS URL if LAP is elsewhere |
| API Key | Any non-empty placeholder, for example `fake-devin-key` |

The server accepts Anthropic-style headers but does not validate the inbound API
key. LAP still needs a value so it can store the runtime credential.

After adding the runtime, select `devin-local` in a LAP session and use a model
returned by `devin models list` (e.g. `opus`, `sonnet`, `swe`, `adaptive`).

## Per-agent model selection

`model` is a **string** in the route contract. Create an agent with the Devin
model name you want and every turn in its sessions runs on that model:

```json
POST /v1/agents
{
  "name": "Agent",
  "model": "opus",
  "system": "..."
}
```

The model is applied to a session via ACP's `session/set_config_option`
(`configId: "model"`) at session creation. If the value isn't recognised by
Devin, the call is ignored and the account default is used.

## System prompts

An agent's `system` prompt is written to `.devin/rules/<agent-id>.mdc` in the
workspace as an always-on Devin rule, so it applies to every session created for
that agent. Rules are re-provisioned from the durable SQLite store on every pod
restart (the workspace is ephemeral; the DB is persistent).

## MCP servers

An agent's `mcp_servers` are passed to ACP `session/new` as `mcpServers`. Both
stdio (`{name, command, args, env}`) and HTTP (`{name, url}`) entries are
supported, mirroring `devin mcp add`.

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `PORT` | `8080` | HTTP port the Anthropic Managed Agents server listens on |
| `WORKDIR` | `/tmp/devin-workspace` | Workspace Devin agents run in (git-init'd at boot so `.devin/` rules load) |
| `DB_PATH` | `/data/agents.db` | SQLite path for durable agent + session bindings |
| `DEVIN_MODEL` | _(unset)_ | Optional default model for every session (fuzzy name e.g. `opus`) |
| `DEVIN_BINARY` | `devin` | Override the devin binary path |
| `DEVIN_DEFAULT_MODEL` | `adaptive` | Fallback model id when `devin models list` is unavailable |
| `WINDSURF_API_KEY` | _(unset)_ | Optional alternative to `devin auth login` — if set, `devin acp` uses it instead of the host's stored credentials |

## How it works

```text
LAP SDK (claude_managed_agents)
  -> devin-agent-server            (Anthropic Managed Agents API, port 8080)
       -> devin acp                (child process, ACP JSON-RPC over stdio)
            -> Devin model routing (via your Devin account)
```

- One `devin acp` child multiplexes all sessions.
- `POST /v1/sessions` maps to ACP `session/new` (+ `session/set_config_option`
  for the model).
- `POST /v1/sessions/:id/events` maps to ACP `session/prompt` (fired without
  awaiting; progress streams as `session/update` notifications).
- `GET /v1/sessions/:id/events/stream` drains per-turn queues of translated
  Anthropic events until the prompt resolves with a stop reason.
- `POST /v1/sessions/:id/abort` maps to the ACP `session/cancel` notification.
- Permission requests from Devin are auto-allowed (this server is headless;
  control permission behaviour via the agent's permission mode / Devin config).

<details>
<summary><strong>EKS deployment</strong></summary>

See [`docs/eks-deployment.md`](./docs/eks-deployment.md) for a guided
Kubernetes deployment, or paste [`docs/eks-deploy-prompt.md`](./docs/eks-deploy-prompt.md)
into a coding agent to deploy the stack end-to-end.

</details>
