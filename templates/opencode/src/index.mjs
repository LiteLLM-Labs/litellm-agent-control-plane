// Express entry: exposes opencode via the Anthropic Managed Agents API spec.
// Boots a child `opencode serve`, persists agents durably, provisions opencode
// per session, and translates opencode SSE -> Anthropic event shapes.
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
import { buildSandboxProvider } from "./sandbox.mjs";
import { createApp } from "./app.mjs";
import { fetchLiteLlmModels } from "./model-list.mjs";
import { opencodeModel, opencodeModelString } from "./models.mjs";

// ---- boot config ----------------------------------------------------------
const PORT = process.env.PORT || 8080;
const OC_PORT = Number(process.env.OPENCODE_PORT || 4096);
const WORKDIR = process.env.WORKDIR || "/tmp/opencode-workspace";
const DB_PATH = process.env.DB_PATH || "/data/agents.db";

mkdirSync(WORKDIR, { recursive: true });

const store = createStore(DB_PATH);

// opencode only loads custom agents in a git project — make the workspace one.
await gitInit(WORKDIR);

// Optionally route opencode's model calls through a LiteLLM gateway.
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || null;
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || null;
// Use built-in opencode provider ID (openai/anthropic); custom IDs trigger
// a runtime npm install that fails in restricted-network environments.
// "openai" sends tool_choice as string "auto" (Chat Completions format),
// which is valid for both Chat Completions and Responses API backends.
const LITELLM_PROVIDER_ID = process.env.LITELLM_PROVIDER_ID || "openai";
const LITELLM_MODELS = (process.env.LITELLM_MODELS || "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
// Optional: override the model opencode uses for internal calls (title generation,
// summarization, etc.). Defaults to the first entry in LITELLM_MODELS.
const LITELLM_DEFAULT_MODEL = process.env.LITELLM_DEFAULT_MODEL || null;
if (LITELLM_BASE_URL && LITELLM_API_KEY) {
  await writeProviderConfig(WORKDIR, {
    id: LITELLM_PROVIDER_ID,
    baseURL: LITELLM_BASE_URL,
    apiKey: LITELLM_API_KEY,
    models: LITELLM_MODELS,
    defaultModel: LITELLM_DEFAULT_MODEL,
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

// Re-provision every stored agent into the (ephemeral) workdir. The SQLite DB
// lives on a persistent volume but the agent .md files live in WORKDIR, which
// is wiped on every pod restart - without this, opencode boots knowing only
// its built-in agents and rejects sessions bound to stored agent ids.
{
  const agents = store.listAgents();
  for (const row of agents) {
    const model = opencodeModel(row.model, DEFAULT_MODEL_PROVIDER_ID);
    if (model?.providerID === LITELLM_PROVIDER_ID) {
      await ensureProviderModel(WORKDIR, model);
    }
    await provisionAgent(WORKDIR, {
      ...row,
      model: opencodeModelString(row.model, DEFAULT_MODEL_PROVIDER_ID),
    });
  }
  await writeMcpConfig(WORKDIR, agents);
  if (agents.length) console.log(`[boot] re-provisioned ${agents.length} stored agent(s)`);
}

async function listModels() {
  if (!LITELLM_BASE_URL || !LITELLM_API_KEY) {
    throw new Error("LITELLM_BASE_URL and LITELLM_API_KEY are required for model discovery");
  }
  return fetchLiteLlmModels({
    baseURL: LITELLM_BASE_URL,
    apiKey: LITELLM_API_KEY,
    ownedBy: LITELLM_PROVIDER_ID,
  });
}

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

// Health probe used by the /health route. Reports opencode readiness without
// awaiting a (possibly slow) boot — `oc` is null until the background start
// settles, in which case we simply report opencode as not-yet-up.
async function checkOpencode() {
  if (!oc) return false;
  try {
    const r = await ocFetch(oc.baseUrl, "/global/health", {});
    return !!r?.ok;
  } catch {
    return false;
  }
}

// ---- app ------------------------------------------------------------------
const app = createApp({
  store,
  workdir: WORKDIR,
  defaultModelProviderID: DEFAULT_MODEL_PROVIDER_ID,
  litellmProviderID: LITELLM_PROVIDER_ID,
  listModels,
  ensureProviderModel,
  provisionAgent,
  writeMcpConfig,
  rebootOpencode,
  ocBase,
  ocFetch,
  checkOpencode,
});

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
