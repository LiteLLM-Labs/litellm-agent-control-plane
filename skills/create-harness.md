# Create a Runtime Template

Scaffold a new `templates/<name>/` — a Node.js/Express server that exposes a new AI agent runtime (e.g. Hermes, Aider, Goose) behind the **Anthropic Managed Agents API spec**, exactly like `templates/opencode/` does for opencode.

When done, any LAP SDK client can drive the new runtime by changing only `api_base`/`api_key`.

---

## Step 1: Interview

Ask only what isn't already obvious from context.

| Question | Why |
|----------|-----|
| **Runtime name** (slug, e.g. `hermes`) | Directory names, env vars, log prefixes |
| **What is it?** (one sentence) | README intro |
| **How does it start?** CLI command, long-running server, or Node/Python library? | Server startup code |
| **How does it accept a prompt?** HTTP POST, stdin, WebSocket, SDK call? | `POST /v1/sessions/:id/events` implementation |
| **How does it stream the reply?** SSE, chunked HTTP, WebSocket, polling? | Event translation layer |
| **Does it support multiple agents?** Per-agent system prompts / tool config? | Whether agent provisioning + runtime reboot is needed |
| **Does it persist session state?** | Whether SQLite session store is needed |
| **Model routing** — own config, or can we inject `LITELLM_BASE_URL`? | Provider wiring |
| **Required env vars** | README table + Dockerfile defaults |
| **Existing Dockerfile or Docker image?** | Starting point |

---

## Step 2: Research the Runtime

Read the runtime's docs/source before writing anything:

1. **Start command** — exact CLI / API, flags, port binding
2. **Session API** — how to create a session; what fields it accepts
3. **Prompt API** — endpoint + request shape that accepts `user.message` parts
4. **Stream API** — SSE event names, chunk format, end-of-turn signal
5. **Abort API** — how to interrupt an in-flight generation
6. **Agent/config loading** — does it read a file at boot? Does it hot-reload or require restart?
7. **Model config** — what env var or config key routes to a provider
8. **Error shapes** — what a failed generation looks like

Summarize findings. Confirm with user before writing code.

---

## Step 3: Scaffold `templates/<name>/`

Follow `templates/opencode/` exactly. Copy every file, then replace only the runtime-specific parts.

```
templates/<name>/
  Dockerfile
  package.json
  render.yaml
  README.md
  src/
    index.mjs        ← main server (adapt from opencode)
    runtime.mjs      ← runtime lifecycle (replaces opencode.mjs)
    anthropic.mjs    ← event translation (adapt translateRuntimeEvent)
    store.mjs        ← SQLite store (copy unchanged)
    models.mjs       ← model normalization (copy unchanged)
    sandbox.mjs      ← OpenSandbox wiring (copy unchanged)
    sandbox-mcp.mjs  ← sandbox MCP server (copy unchanged)
  scripts/
    smoke.sh
  docs/
    eks-deployment.md
    eks-deploy-prompt.md
```

---

## Step 4: Implement Every Scenario

The server must handle all of the following. Each one maps to a concrete route or lifecycle function. **Do not skip any.**

### 4.1 Health check — `GET /health`

Returns `{"ok":true,"<name>":bool}`. The `<name>` boolean is `true` only when the runtime child process is running and passes a health probe.

```js
app.get("/health", wrap(async (_req, res) => {
  let healthy = false;
  if (rt) {
    try { healthy = await runtimeHealthCheck(rt.baseUrl); } catch {}
  }
  res.json({ ok: true, <name>: healthy });
}));
```

### 4.2 Create agent — `POST /v1/agents`

- Store `{name, model, system, permissions, mcp_servers}` in SQLite via `store.createAgent()`
- Write per-agent config to disk (system prompt file, tool permissions, MCP entries)
- Rebuild the full MCP config from ALL agents (`writeMcpConfig`)
- Reboot the runtime child so it picks up the new config (runtimes don't hot-reload)
- Return `agentResponse(row)`

```js
app.post("/v1/agents", wrap(async (req, res) => {
  const row = store.createAgent({ name, model: modelId(model), system, permissions, mcp_servers });
  await applyAgentsAndReboot(row);
  res.json(agentResponse(row));
}));
```

### 4.3 List agents — `GET /v1/agents`

```js
app.get("/v1/agents", wrap(async (_req, res) => {
  res.json({ data: store.listAgents().map(agentResponse) });
}));
```

### 4.4 Get agent — `GET /v1/agents/:id`

Return 404 if not found.

### 4.5 Update agent — `PATCH /v1/agents/:id`

Accept partial updates to `{name, model, system, permissions, mcp_servers}`. Patch SQLite, re-provision config, reboot runtime. Return 404 if agent not found.

### 4.6 Create environment — `POST /v1/environments`

Lightweight: generate an `env_<hex>` ID, store `{name, config}` in memory (or SQLite), return it. Environments are workspace configs; the runtime doesn't need to act on them at creation time.

### 4.7 Create session — `POST /v1/sessions`

- Look up the agent by `req.body.agent` — return 400 `"unknown agent"` if missing
- Call the runtime's session-create endpoint
- Extract the session ID from the runtime response
- Call `store.bindSession(runtimeSessionId, agentId)` so later event sends can resolve the agent
- Return `sessionResponse({id, agentId, environmentId})`

```js
app.post("/v1/sessions", wrap(async (req, res) => {
  const row = store.getAgent(req.body?.agent);
  if (!row) return res.status(400).json({ error: "unknown agent" });
  const ses = await createRuntimeSession(rt.baseUrl, row);
  store.bindSession(ses.id, row.id);
  res.json(sessionResponse({ id: ses.id, agentId: row.id, environmentId: req.body.environment_id }));
}));
```

### 4.8 Send events (prompt) — `POST /v1/sessions/:id/events`

- Extract `user.message` parts from `req.body.events` using `partsFromEvents()` (copy from `anthropic.mjs`)
- Return 400 `"no user.message parts"` if empty
- Look up the bound agent for this session via `store.getSessionAgent()`
- Call the runtime's async prompt endpoint with `{agent, model, parts}`
- Return 202 `{ok: true}`

```js
app.post("/v1/sessions/:id/events", wrap(async (req, res) => {
  const parts = partsFromEvents(req.body?.events || []);
  if (!parts.length) return res.status(400).json({ error: "no user.message parts" });
  const agentId = store.getSessionAgent(req.params.id);
  const agent = agentId ? store.getAgent(agentId) : null;
  await sendRuntimePrompt(rt.baseUrl, req.params.id, { agent, parts });
  res.status(202).json({ ok: true });
}));
```

### 4.9 Abort session — `POST /v1/sessions/:id/abort`

Proxy to the runtime's abort endpoint. Return `{aborted: true/false}`.

### 4.10 Historical events — `GET /v1/sessions/:id/events`

Stub. Return `{data: []}`. (Full replay is out of scope for a v1 template.)

### 4.11 Live event stream — `GET /v1/sessions/:id/events/stream`

This is the most complex route. It must:

1. Set `content-type: text/event-stream` + `cache-control: no-cache` + `connection: keep-alive`
2. Open a long-lived connection to the runtime's event bus (SSE or equivalent)
3. Parse the runtime's stream into complete event records
4. For each record, call `translateRuntimeEvent(ev, {sessionId, model})` to convert to an Anthropic event shape
5. Write `event: <type>\ndata: <json>\n\n` to the response
6. On client disconnect, abort the upstream connection
7. Swallow `AbortError`; log other errors

```js
app.get("/v1/sessions/:id/events/stream", wrap(async (req, res) => {
  // ... (see templates/opencode/src/index.mjs for the full streaming loop)
}));
```

### 4.12 `translateRuntimeEvent` — in `src/anthropic.mjs`

Maps runtime-native events to Anthropic SSE shapes. Must handle **all** of:

| Input (runtime event) | Output (Anthropic event) | Data shape |
|----------------------|--------------------------|-----------|
| Text delta / content chunk | `agent.message` | `{content:[{type:"text",text}], model}` |
| Thinking/reasoning delta | `agent.thinking` | `{thinking}` |
| Tool call | `agent.tool_use` | `{id, name, input}` |
| Tool result | `agent.tool_result` | `{tool_use_id, content}` |
| Generation started / turn running | `session.status_running` | `{}` |
| Generation done / turn idle | `session.status_idle` | `{stop_reason:{type:"end_turn"}}` |
| Error from runtime | `session.error` | `{error:{message}}` |
| Unknown / drop | `null` | — |

### 4.13 Model normalization — `src/models.mjs`

Copy unchanged from `templates/opencode/src/models.mjs`. Handles:
- Bare model names (`claude-sonnet-4-6`) → default to configured LiteLLM provider
- `provider/model` strings → split into `{providerID, modelID}`
- Ensures `ensureProviderModel()` registers new model IDs into opencode.json before first use

### 4.14 LiteLLM provider wiring

At boot, if `LITELLM_BASE_URL` + `LITELLM_API_KEY` are set:
- Call `writeProviderConfig(WORKDIR, {id:"litellm", baseURL, apiKey, models:LITELLM_MODELS})`
- This writes `opencode.json` with the provider pointing at `{baseURL}/messages` (Anthropic Messages API format)
- Clients address models as `claude-sonnet-4-6` (bare) or `litellm/claude-sonnet-4-6`

Default `LITELLM_MODELS`: `claude-sonnet-4-6`

### 4.15 OpenSandbox wiring (optional)

Copy `src/sandbox.mjs` and `src/sandbox-mcp.mjs` unchanged. At boot:
- If `OPENSANDBOX_API_URL` is set, call `writeSandboxConfig()` to:
  - Deny native `bash` and `edit` tools
  - Wire a `sandbox` MCP entry (`sandbox_exec`, `sandbox_read_file`, `sandbox_write_file`)
- Log `"[boot] sandbox execution enabled — bash/edit denied, routed to sandbox MCP"`

### 4.16 SQLite persistence — `src/store.mjs`

Copy unchanged. Persists:
- Agents: `{id, name, model, system, permissions, mcp_servers, version}`
- Sessions: `session_id → agent_id` binding

### 4.17 Graceful shutdown

Handle `SIGTERM` and `SIGINT`:
- Close the HTTP server
- Stop the runtime child process
- `process.exit(0)`

Use a `shuttingDown` guard so the handler is idempotent.

### 4.18 Runtime reboot on agent change

Runtimes that don't hot-reload (most don't) need to be restarted whenever an agent's config changes. Use a `serialize()` queue so concurrent agent creates/patches don't race.

```js
const serialize = (() => {
  let q = Promise.resolve();
  return (fn) => { q = q.then(fn, fn); return q; };
})();

async function rebootRuntime() {
  rt = await serialize(() => restartRuntime(rt, { port: RT_PORT, cwd: WORKDIR }));
}
```

---

## Step 5: Non-code files

### `Dockerfile`

```dockerfile
FROM node:20   # or python:3.12, etc — match runtime language
RUN <install runtime CLI/package>
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
RUN mkdir -p /data /tmp/<name>-workspace
ENV PORT=8080 WORKDIR=/tmp/<name>-workspace DB_PATH=/data/agents.db
EXPOSE 8080
CMD ["node", "src/index.mjs"]
```

### `scripts/smoke.sh`

Copy from `templates/opencode/scripts/smoke.sh`. Default model: `claude-sonnet-4-6`.

### `README.md`

Copy structure from `templates/opencode/README.md`:
1. ASCII diagram (GKE/EKS → Agent Control Plane → Agent Server → Sandbox)
2. Docker quickstart
3. LAP SDK snippet using `claude-sonnet-4-6`
4. Environment variables table (PORT, WORKDIR, DB_PATH, LITELLM_*, OPENSANDBOX_*)
5. EKS section (`<details>`) linking to `docs/eks-deployment.md`

### `docs/eks-deployment.md` and `docs/eks-deploy-prompt.md`

Copy from `templates/opencode/docs/`, replacing `opencode-anthropic-server` → `<name>-server` and `opencode` → `<name>` throughout.

---

## Step 5b: Wire into the LAP UI (if the runtime deserves its own dropdown entry)

Templates that speak the Anthropic Managed Agents API spec (`claude_managed_agents`) need **no UI changes** — users just register a new runtime, select `claude_managed_agents` as the API spec, and point the base URL at the new server.

If the runtime should appear as its own named option in the runtime creation dropdown (like opencode does), add it to **4 spots** in `src/ui/src/`:

### 1. `app/runtimes/page.tsx` — add to `SPEC_DEFAULTS`

```ts
const SPEC_DEFAULTS: Record<string, string> = {
  claude_managed_agents: "https://api.anthropic.com",
  opencode: "http://127.0.0.1:4096",
  <name>: "http://127.0.0.1:<default-port>",   // ← add
};
```

### 2. `app/runtimes/page.tsx` — add to `API_SPEC_LABELS`

```ts
const API_SPEC_LABELS: Record<string, string> = {
  claude_managed_agents: "Claude Managed Agents",
  opencode: "OpenCode",
  <name>: "<Display Name>",   // ← add
};
```

### 3. `app/runtimes/page.tsx` — add `<SelectItem>` to the dropdown

```tsx
<SelectItem value="claude_managed_agents">Claude Managed Agents</SelectItem>
<SelectItem value="opencode">OpenCode</SelectItem>
<SelectItem value="<name>"><Display Name></SelectItem>  {/* ← add */}
```

### 4. `app/runtimes/page.tsx` — add to `harnessIconId`

```ts
function harnessIconId(alias: string): string {
  if (alias === "claude_managed_agents") return "claude";
  if (alias === "opencode") return "opencode";
  if (alias === "<name>") return "<name>";   // ← add (if brand icon exists)
  return "default";
}
```

### 5. `components/brand-icons.tsx` — add brand icon (optional)

If a logo SVG is available, import and register it:

```ts
import <Name>Icon from "./icons/<name>.svg";
// ...
export const brandIcons = {
  opencode: OpenCodeIcon,
  <name>: <Name>Icon,   // ← add
};
```

If no icon is available, skip this step — `harnessIconId` falling through to `"default"` is fine.

---

## Step 6: Verify

### 6.1 Syntax and build

```bash
node --check templates/<name>/src/index.mjs
node --check templates/<name>/src/runtime.mjs
docker build --platform linux/amd64 -t <name>-server-test templates/<name>/
```

### 6.2 Start the server locally

```bash
cd templates/<name>
npm install
LITELLM_BASE_URL=<gateway>/v1 LITELLM_API_KEY=<key> LITELLM_MODELS=claude-sonnet-4-6 \
  node src/index.mjs
```

Confirm `GET http://localhost:8080/health` returns `{"ok":true,"<name>":true}`.

### 6.3 Add to LAP as a runtime

In the LAP UI: **AI Gateway → Agent Runtimes → Add Runtime**

| Field | Value |
|-------|-------|
| Alias | `<name>-local` |
| API Spec | `claude_managed_agents` (or `<name>` if you added a UI entry) |
| API Base | `http://localhost:8080` |
| API Key | any non-empty string (e.g. `test`) |

Save it.

### 6.4 Hello world test (API)

Run the end-to-end test against the running server:

```bash
BASE=http://localhost:8080 MODEL=claude-sonnet-4-6

# Health
curl -s $BASE/health

# Create agent
AGENT_ID=$(curl -sf -X POST $BASE/v1/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"test","model":"claude-sonnet-4-6","system":"You are helpful."}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "agent: $AGENT_ID"

# Create session
SESSION_ID=$(curl -sf -X POST $BASE/v1/sessions \
  -H "Content-Type: application/json" \
  -d "{\"agent\":\"$AGENT_ID\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "session: $SESSION_ID"

# Open SSE stream
SSE_LOG=$(mktemp)
curl -sN $BASE/v1/sessions/$SESSION_ID/events/stream \
  -H "Accept: text/event-stream" > $SSE_LOG &
sleep 1

# Send message
curl -sf -X POST $BASE/v1/sessions/$SESSION_ID/events \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"user.message","content":"say hello world"}]}' > /dev/null

# Wait for idle and print reply
for i in $(seq 1 60); do sleep 1; grep -qa 'session.status_idle' $SSE_LOG && break; done
python3 -c "
ev=None
for l in open('$SSE_LOG'):
    l=l.strip()
    if l.startswith('event:'): ev=l[6:].strip()
    elif l.startswith('data:') and ev=='agent.message':
        import json
        for b in json.loads(l[5:]).get('content',[]): print(b.get('text',''),end='')
print()
"
kill %1 2>/dev/null; rm -f $SSE_LOG
```

Expected: a short reply from the model (e.g. `Hello, World! 👋`). If the reply is empty, check `session.error` events in the SSE log and server logs for the root cause.

### 6.5 Hello world test via smoke script

```bash
BASE=http://localhost:8080 MODEL=claude-sonnet-4-6 templates/<name>/scripts/smoke.sh
```

All steps should pass (health, agent create, session create, message send, `agent.message` received, `session.status_idle` received).

---

## Step 7: File PR to litellm-agent-platform-2

Branch: `feat/template-<name>`

PR body: what the runtime is, how it wires to LiteLLM, any limitations vs opencode, link to runtime docs.
