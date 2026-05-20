# Contributing / Local Dev

Run the platform locally without rebuilding Docker images on every change.

## Prerequisites

- Node.js 20+
- Access to the Neon DB (connection string in `.env`)
- Access to the LiteLLM gateway (`LITELLM_API_BASE` + `LITELLM_API_KEY`)
- A local directory to use as the agent's working directory (e.g. a clone of the litellm repo)

## 1. Install dependencies

```bash
npm install
cd harnesses/claude-agent-sdk && npm install && cd ../..
```

## 2. Configure `.env`

Copy `.env.example` to `.env` and fill in:

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Neon direct (non-pooled) connection string |
| `MASTER_KEY` | Bearer token for API auth — any string works locally |
| `LITELLM_API_BASE` | LiteLLM gateway URL, e.g. `https://gateway.litellm.ai/` |
| `LITELLM_API_KEY` | Key accepted by that gateway |
| `ENCRYPTION_KEY` | AES-256 key for agent env var encryption (pull from EKS secret or generate) |
| `LOCAL_SANDBOX_URL` | Set to `http://localhost:4096` to bypass K8s entirely |
| `WARM_POOL_SIZE` | Set to `0` — no K8s pods to pre-provision locally |
| `PREINSTALLED_GITHUB_REPO` | Any public repo URL; used as fallback when an agent has no `repo_url` |

Minimal working `.env` for local dev:

```dotenv
DATABASE_URL="postgresql://..."
MASTER_KEY=sk-local-dev
LITELLM_API_BASE="https://gateway.litellm-sandbox.ai/"
LITELLM_API_KEY="sk-..."
ENCRYPTION_KEY=<base64-encoded 32-byte key>
PREINSTALLED_GITHUB_REPO=https://github.com/BerriAI/litellm
LOCAL_SANDBOX_URL=http://localhost:4096
WARM_POOL_SIZE=0
IN_CLUSTER=false
```

To generate a fresh `ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## 3. Start the Next.js dev server

```bash
npm run dev
```

Runs on http://localhost:3000. Hot-reloads on every save.

## 4. Start the harness

The harness is the process that runs the Claude SDK for each agent session. With `LOCAL_SANDBOX_URL` set, every session routes here instead of spinning up a K8s pod.

```bash
cd harnesses/claude-agent-sdk

# Build once (or after source changes):
npm run build

# Start with a real working directory for the agent:
REPO_DIR=/path/to/your/local/repo \
LITELLM_API_BASE="https://gateway.litellm-sandbox.ai/" \
LITELLM_API_KEY="sk-..." \
node dist/server.js
```

`REPO_DIR` must be a directory that exists on your machine — the Claude SDK spawns its subprocess with that as the working directory. A local clone of any repo works (the agent will have read/write access to it during a session).

The harness prints its config on startup:

```
claude-agent-sdk harness listening on http://0.0.0.0:4096
  cwd=/path/to/your/local/repo model=claude-haiku-4-5
  base=https://gateway.litellm-sandbox.ai
```

## 5. Verify end-to-end

```bash
BASE=http://localhost:3000
KEY=sk-local-dev   # matches MASTER_KEY in .env

# Create an agent
AGENT_ID=$(curl -sS $BASE/api/v1/managed_agents/agents \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"name":"test","harness_id":"claude-agent-sdk","model":"anthropic/claude-haiku-4-5","prompt":"You are a helpful assistant."}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

# Create a session
SID=$(curl -sS $BASE/api/v1/managed_agents/agents/$AGENT_ID/session \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"title":"test"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

# Wait for ready (usually <2s with LOCAL_SANDBOX_URL)
curl -sS $BASE/api/v1/managed_agents/sessions/$SID \
  -H "authorization: Bearer $KEY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])'

# Send a message
curl -sS $BASE/api/v1/managed_agents/sessions/$SID/message \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"text":"Say hello."}'
```

## How `LOCAL_SANDBOX_URL` works

When `LOCAL_SANDBOX_URL` is set, `coldBringUp` in the session creation route skips the K8s `RunTask` / pod-wait / Fargate flow entirely and connects directly to the local harness at that URL. The harness handshake, message routing, and SSE event stream all work identically to production — only the sandbox provisioning is skipped.

The `WARM_POOL_SIZE=0` setting prevents the background reconciler from trying to pre-provision K8s pods, which would fail without cluster access.

## Testing the brain-inline harness locally

`brain-inline` is a harness mode where the Claude loop runs inside the Next.js platform process instead of inside a remote harness container. The sandbox is a lightweight command executor — it receives shell commands from the platform and returns stdout. Because there is no pod to spin up, sessions reach `ready` in under 200ms.

### Start the executor

Instead of the full `claude-agent-sdk` harness, start the executor:

```bash
cd harnesses/executor
npm install && npm run build
REPO_DIR=/path/to/your/local/repo node dist/server.js
# executor harness listening on http://0.0.0.0:4096
```

`REPO_DIR` must be a real directory on your machine — shell commands execute there.

### .env is the same

No `.env` changes are needed beyond what is already described above. `LOCAL_SANDBOX_URL=http://localhost:4096` continues to point at whatever is listening on that port — now the executor instead of the full harness.

### Create a brain-inline agent and test

```bash
BASE=http://localhost:3000
KEY=sk-local-dev

AGENT_ID=$(curl -sS $BASE/api/v1/managed_agents/agents \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"name":"brain-test","harness_id":"brain-inline","model":"anthropic/claude-haiku-4-5","prompt":"You are a helpful assistant. When you need to run code, use the provision and execute tools."}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

# Session is ready immediately — no pod spinup
SID=$(curl -sS $BASE/api/v1/managed_agents/agents/$AGENT_ID/session \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"title":"test"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

# Text-only — no executor call, ~2s response
curl -sS $BASE/api/v1/managed_agents/sessions/$SID/message \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"text":"What is 2+2?"}'

# Tool use — Claude calls provision then execute
curl -sS $BASE/api/v1/managed_agents/sessions/$SID/message \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"text":"List the files in the current directory using a sandbox."}'
```

### What to verify

| Check | Expected |
|---|---|
| Session create latency | Returns in <200ms |
| Text-only message | `task_arn` stays `null` on the session row |
| Tool-use message | Executor receives `POST /execute`; Claude gets stdout back in the thread |

### Difference from `claude-agent-sdk` local dev

With `claude-agent-sdk`, the full Claude loop runs inside the harness process at `localhost:4096` — the platform only forwards the message and streams events back. With `brain-inline`, the Claude loop runs inside the Next.js platform process itself. The executor at `localhost:4096` is a dumb command runner: it only receives `POST /execute` requests and returns shell output. No Claude SDK, no agent loop, no SSE event stream lives at that port.

## Common issues

**`SDKError: Claude Code native binary not found`** — The Claude SDK spawns a subprocess with `cwd=REPO_DIR`. If `REPO_DIR` is unset it defaults to `/work/repo` (a Docker path that doesn't exist locally). Set `REPO_DIR` to any real directory.

**`No healthy deployments for model=...`** — The model name doesn't match a deployment on your gateway. Check `$LITELLM_API_BASE/models` for available model IDs.

**`ENCRYPTION_KEY is required`** — `buildVaultEnv` can't decrypt agent env vars. Set `ENCRYPTION_KEY` in `.env` (pull from EKS with `kubectl get secret litellm-env -o jsonpath='{.data.ENCRYPTION_KEY}' | base64 -d`).

**Worker `ENOTFOUND host.docker.internal`** — The worker reconciler tries to reach the K8s cluster. Non-fatal locally; set `WARM_POOL_SIZE=0` and `IN_CLUSTER=false` to suppress most of it.
