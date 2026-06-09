// Express entry: exposes opencode via the Anthropic Managed Agents API spec.
// Boots a child `opencode serve`, persists agents durably, provisions opencode
// per session, and translates opencode SSE -> Anthropic event shapes.
import express from "express";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";

import { createStore } from "./store.mjs";
import {
  startOpencode,
  provisionAgent,
  writeMcpConfig,
  writeSandboxConfig,
  ocFetch,
  writeProviderConfig,
  ensureProviderModel,
  gitInit,
} from "./opencode.mjs";
import { opencodeModel, opencodeModelString } from "./models.mjs";
import { buildSandboxProvider } from "./sandbox.mjs";
import {
  modelId,
  agentResponse,
  sessionResponse,
  partsFromEvents,
  translateOpencodeEvent,
} from "./anthropic.mjs";

// ---- boot config ----------------------------------------------------------
const PORT = process.env.PORT || 8080;
const OC_PORT = Number(process.env.OPENCODE_PORT || 4096);
const WORKDIR = process.env.WORKDIR || "/tmp/opencode-workspace";
const DB_PATH = process.env.DB_PATH || "/data/agents.db";

mkdirSync(WORKDIR, { recursive: true });

const store = createStore(DB_PATH);

// opencode only loads custom agents in a git project — make the workspace one.
await gitInit(WORKDIR);

// Optionally route opencode's model calls through a LiteLLM gateway. When
// LITELLM_BASE_URL + LITELLM_API_KEY are set, opencode addresses models as
// "litellm/<model>" (e.g. litellm/claude-sonnet-4-6).
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || null;
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || null;
const LITELLM_PROVIDER_ID = "litellm";
const LITELLM_MODELS = (process.env.LITELLM_MODELS || "claude-sonnet-4-6")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
if (LITELLM_BASE_URL && LITELLM_API_KEY) {
  await writeProviderConfig(WORKDIR, {
    id: LITELLM_PROVIDER_ID,
    baseURL: LITELLM_BASE_URL,
    apiKey: LITELLM_API_KEY,
    models: LITELLM_MODELS,
  });
  console.log(`[boot] litellm provider configured -> ${LITELLM_BASE_URL} (models: ${LITELLM_MODELS.join(", ")})`);
}

// Optionally route the agent's command/file execution into a remote sandbox
// (e.g. OpenSandbox) instead of running on this host. When configured, native
// bash/edit are denied and a sandbox-exec MCP server is wired into opencode.
const sandbox = buildSandboxProvider(process.env);
if (sandbox.error) {
  console.error(`[boot] sandbox config error: ${sandbox.error}`);
} else if (sandbox.provider) {
  const mcpPath = new URL("./sandbox-mcp.mjs", import.meta.url).pathname;
  await writeSandboxConfig(WORKDIR, {
    command: ["node", mcpPath],
    env: {
      SANDBOX_PROVIDER: process.env.SANDBOX_PROVIDER || "opensandbox",
      OPENSANDBOX_API_URL: process.env.OPENSANDBOX_API_URL || "",
      OPENSANDBOX_IMAGE: process.env.OPENSANDBOX_IMAGE || "",
      OPENSANDBOX_API_KEY: process.env.OPENSANDBOX_API_KEY || "",
    },
  });
  console.log(
    `[boot] sandbox execution enabled (${sandbox.provider.providerName}) — bash/edit denied, routed to sandbox MCP`
  );
}
const DEFAULT_MODEL_PROVIDER_ID = LITELLM_BASE_URL && LITELLM_API_KEY ? LITELLM_PROVIDER_ID : null;

const ocOpts = { port: OC_PORT, cwd: WORKDIR };

// opencode lifecycle. It boots in the BACKGROUND so the web server can bind its
// port immediately (platforms like Render kill a service that opens no port at
// boot). opencode has no hot-reload, so after writing agent config we reboot it.
//
// All start/reboot transitions run through `serialize` so they never overlap, and
// `oc` is set to null while a (re)start is in flight — callers therefore never
// receive a killed or half-started handle, and a failed start leaves oc null so
// the next request retries cleanly.
let oc = null;
let ocLock = Promise.resolve();
function serialize(fn) {
  const run = ocLock.then(fn, fn);
  ocLock = run.then(
    () => {},
    () => {}
  );
  return run;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureOpencode() {
  return serialize(async () => {
    if (oc) return oc;
    console.log(`[boot] starting opencode on port ${OC_PORT} (cwd=${WORKDIR})`);
    oc = await startOpencode(ocOpts); // throws -> oc stays null, caller retries
    console.log(`[boot] opencode ready at ${oc.baseUrl}`);
    return oc;
  });
}
async function ocBase() {
  return (await ensureOpencode()).baseUrl;
}
function rebootOpencode() {
  return serialize(async () => {
    const old = oc;
    oc = null; // invalidate before killing so nothing uses the dead handle
    try {
      old?.stop?.();
    } catch {
      /* ignore */
    }
    await sleep(600); // let the port free
    oc = await startOpencode(ocOpts);
    console.log(`[reboot] opencode reloaded at ${oc.baseUrl}`);
    return oc;
  });
}
// kick off boot in the background; failures are non-fatal (retried on demand).
ensureOpencode().catch((e) =>
  console.error("[boot] opencode start failed (will retry on demand):", e.message)
);

// In-memory environments registry (envId -> config).
const environments = new Map();

// ---- app ------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "5mb" }));

// Honor (but don't strictly require) Anthropic-style headers.
app.use((req, _res, next) => {
  req.apiKey = req.get("x-api-key") || null;
  req.anthropicVersion = req.get("anthropic-version") || null;
  req.anthropicBeta = req.get("anthropic-beta") || null;
  next();
});

// Wrap async handlers so throws become 500 {error}.
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[error] ${req.method} ${req.path}:`, err);
    if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
    else try { res.end(); } catch {}
  });

// ---- health ---------------------------------------------------------------
// Non-blocking: report opencode readiness WITHOUT awaiting a (possibly slow)
// boot. The web server is healthy as soon as the port is up; opencode comes
// online in the background. Blocking here would hang the platform health check.
app.get("/health", wrap(async (_req, res) => {
  let opencode = false;
  if (oc) {
    try {
      const r = await ocFetch(oc.baseUrl, "/global/health", {});
      opencode = !!r?.ok;
    } catch {
      opencode = false;
    }
  }
  res.json({ ok: true, opencode });
}));

// ---- agents ---------------------------------------------------------------
// Write an agent's config to disk and reboot opencode so it loads (opencode has
// no hot-reload). The mcp section is rebuilt from ALL agents so one agent's
// servers never leak into another's sessions.
async function applyAgentsAndReboot(provisionRow) {
  if (provisionRow) {
    const model = opencodeModel(provisionRow.model, DEFAULT_MODEL_PROVIDER_ID);
    if (model?.providerID === LITELLM_PROVIDER_ID) {
      await ensureProviderModel(WORKDIR, model);
    }
    await provisionAgent(WORKDIR, {
      ...provisionRow,
      model: opencodeModelString(provisionRow.model, DEFAULT_MODEL_PROVIDER_ID),
    });
  }
  await writeMcpConfig(WORKDIR, store.listAgents());
  await rebootOpencode();
}

app.post("/v1/agents", wrap(async (req, res) => {
  const { name, model, system } = req.body || {};
  const row = store.createAgent({
    name,
    system: system || "",
    model: modelId(model),
    permissions: req.body.permissions || {},
    mcp_servers: req.body.mcp_servers || [],
    workspace: null,
  });
  await applyAgentsAndReboot(row);
  res.json(agentResponse(row));
}));

app.get("/v1/agents", wrap(async (_req, res) => {
  res.json({ data: store.listAgents().map(agentResponse) });
}));

app.get("/v1/agents/:id", wrap(async (req, res) => {
  const row = store.getAgent(req.params.id);
  if (!row) return res.status(404).json({ error: "agent not found" });
  res.json(agentResponse(row));
}));

// Update an agent (e.g. change the system prompt or add MCP servers), rewrite
// its config, and reboot opencode to apply.
app.patch("/v1/agents/:id", wrap(async (req, res) => {
  const patch = {};
  if (req.body?.name !== undefined) patch.name = req.body.name;
  if (req.body?.system !== undefined) patch.system = req.body.system;
  if (req.body?.model !== undefined) patch.model = modelId(req.body.model);
  if (req.body?.permissions !== undefined) patch.permissions = req.body.permissions;
  if (req.body?.mcp_servers !== undefined) patch.mcp_servers = req.body.mcp_servers;
  const row = store.updateAgent(req.params.id, patch);
  if (!row) return res.status(404).json({ error: "agent not found" });
  await applyAgentsAndReboot(row);
  res.json(agentResponse(row));
}));

// ---- environments ---------------------------------------------------------
app.post("/v1/environments", wrap(async (req, res) => {
  const { name, config } = req.body || {};
  const id = "env_" + crypto.randomBytes(16).toString("hex");
  environments.set(id, config || {});
  res.json({ id, type: "environment", name, config: config || {} });
}));

// ---- sessions -------------------------------------------------------------
app.post("/v1/sessions", wrap(async (req, res) => {
  const row = store.getAgent(req.body?.agent);
  if (!row) return res.status(400).json({ error: "unknown agent" });

  const r = await ocFetch(await ocBase(), "/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: req.body.title || row.name + " session" }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    return res
      .status(502)
      .json({ error: `opencode session create failed (${r.status})`, detail: detail.slice(0, 500) });
  }
  const ses = await r.json().catch(() => ({}));
  const sid = ses.id;
  if (!sid) {
    return res.status(502).json({ error: "opencode session response missing id" });
  }

  store.bindSession(sid, row.id);

  res.json(
    sessionResponse({
      id: sid,
      agentId: row.id,
      environmentId: req.body.environment_id,
    })
  );
}));

// Submit events (user.message parts) -> opencode prompt_async.
app.post("/v1/sessions/:id/events", wrap(async (req, res) => {
  const agentId = store.getSessionAgent(req.params.id);
  const agent = agentId ? store.getAgent(agentId) : null;

  const parts = partsFromEvents(req.body?.events || []);
  if (!parts.length) return res.status(400).json({ error: "no user.message parts" });

  const r = await ocFetch(await ocBase(), `/session/${req.params.id}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // Select the agent loaded from disk so opencode applies its system
      // prompt, tool permissions, and MCP servers.
      agent: agentId || undefined,
      model: opencodeModel(agent?.model, DEFAULT_MODEL_PROVIDER_ID),
      parts,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    return res
      .status(502)
      .json({ error: `opencode prompt failed (${r.status})`, detail: detail.slice(0, 500) });
  }

  res.status(202).json({ ok: true });
}));

// Interrupt the in-flight turn — proxies opencode's session abort.
app.post("/v1/sessions/:id/abort", wrap(async (req, res) => {
  const r = await ocFetch(await ocBase(), `/session/${req.params.id}/abort`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  res.status(r.ok ? 200 : r.status).json({ aborted: r.ok });
}));

// Historical events (stub).
app.get("/v1/sessions/:id/events", wrap(async (_req, res) => {
  res.json({ data: [] });
}));

// Live SSE stream: opencode events -> Anthropic event shapes.
app.get("/v1/sessions/:id/events/stream", wrap(async (req, res) => {
  const agentId = store.getSessionAgent(req.params.id);
  const agent = agentId ? store.getAgent(agentId) : null;
  const model = agent?.model || null;

  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  try {
    const upstream = await ocFetch(await ocBase(), "/event", { signal: controller.signal });
    if (!upstream.ok || !upstream.body) {
      res.write(
        `event: session.error\ndata: ${JSON.stringify({
          error: { message: `opencode /event unavailable (${upstream.status})` },
        })}\n\n`
      );
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });

      // Consume only complete \n\n-delimited records.
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        // Collect the data: line(s) within this block.
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;

        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }

        const out = translateOpencodeEvent(ev, { sessionId: req.params.id, model });
        if (out && out.event) {
          res.write(`event: ${out.event}\ndata: ${JSON.stringify(out.data)}\n\n`);
        }
      }
    }
  } catch (err) {
    // Swallow abort errors; don't surface to a half-open stream.
    if (err?.name !== "AbortError" && !controller.signal.aborted) {
      console.error(`[stream] ${req.params.id}:`, err);
    }
  } finally {
    try { res.end(); } catch {}
  }
}));

// ---- listen + lifecycle ---------------------------------------------------
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] agent server listening on :${PORT}`);
});

let shuttingDown = false;
const shutdown = async (sig) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] received ${sig}, stopping...`);
  try { server.close(); } catch {}
  try { await oc.stop(); } catch (e) { console.error("[shutdown] oc.stop:", e); }
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
