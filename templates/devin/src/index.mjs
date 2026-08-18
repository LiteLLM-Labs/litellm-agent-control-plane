// Express entry: exposes Devin CLI via the Anthropic Managed Agents API spec.
// Boots a single `devin acp` child (ACP over stdio), persists agents durably,
// provisions each agent's system prompt as a Devin rule, and translates ACP
// session/update notifications -> Anthropic event shapes.
import { mkdirSync } from "node:fs";
import path from "node:path";

import { createStore } from "./store.mjs";
import { startAcp } from "./acp.mjs";
import {
  gitInit,
  provisionRule,
  removeRule,
  reprovisionRules,
  toAcpMcpServers,
  listDevinModels,
} from "./devin.mjs";
import { createApp } from "./app.mjs";

// ---- boot config ----------------------------------------------------------
const PORT = process.env.PORT || 8080;
const WORKDIR = process.env.WORKDIR || "/tmp/devin-workspace";
const DB_PATH = process.env.DB_PATH || "/data/agents.db";
// Optional default model for every `devin acp` session (fuzzy name e.g. "opus").
const DEVIN_MODEL = process.env.DEVIN_MODEL || null;
// Optional devin binary path (default: "devin" on PATH).
const DEVIN_BINARY = process.env.DEVIN_BINARY || "devin";

mkdirSync(WORKDIR, { recursive: true });
mkdirSync(path.dirname(DB_PATH), { recursive: true });

const store = createStore(DB_PATH);

// Devin only loads .devin/ rules inside a git project — make the workspace one.
await gitInit(WORKDIR);

// Re-provision every stored agent's rule into the (ephemeral) workdir. The
// SQLite DB lives on a persistent volume but .devin/ lives in WORKDIR, which is
// wiped on every pod restart — without this, sessions bound to stored agent
// ids would lose their system-prompt rules after a restart.
// Done after server.listen() below so port binding is not delayed.

async function listModels() {
  return listDevinModels({ binary: DEVIN_BINARY, ownedBy: "devin" });
}

// ---- ACP child lifecycle --------------------------------------------------
// One `devin acp` child multiplexes all sessions. It boots in the BACKGROUND so
// the web server can bind its port immediately (platforms like Render kill a
// service that opens no port at boot). If it dies, the next request triggers a
// restart via ensureAcp.
let acp = null;
let acpLock = Promise.resolve();
function serialize(fn) {
  const run = acpLock.then(fn, fn);
  acpLock = run.then(() => {}, () => {});
  return run;
}

async function bootAcp() {
  console.log(`[boot] starting devin acp (cwd=${WORKDIR}${DEVIN_MODEL ? `, model=${DEVIN_MODEL}` : ""})`);
  const handle = await startAcp({
    cwd: WORKDIR,
    model: DEVIN_MODEL,
    binary: DEVIN_BINARY,
  });
  handle.onDead((err) => {
    console.error("[acp] child died:", err?.message || err);
    if (acp === handle) acp = null;
  });
  console.log("[boot] devin acp ready");
  return handle;
}

function ensureAcp() {
  return serialize(async () => {
    if (acp && acp.isAlive()) return acp;
    acp = await bootAcp(); // throws -> acp stays null, caller retries
    return acp;
  });
}

function checkAcp() {
  return !!(acp && acp.isAlive());
}

// Kick off boot in the background; failures are non-fatal (retried on demand).
ensureAcp().catch((e) =>
  console.error("[boot] devin acp start failed (will retry on demand):", e?.message || e)
);

// ---- app ------------------------------------------------------------------
const app = createApp({
  store,
  workdir: WORKDIR,
  ensureAcp,
  checkAcp,
  provisionRule,
  removeRule,
  toAcpMcpServers,
  listModels,
});

// ---- listen + lifecycle ---------------------------------------------------
// Re-provision rules BEFORE listening so a session/new arriving immediately
// after port binding finds the rules already in place.
await reprovisionRules(WORKDIR, store.listAgents(), provisionRule);

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] agent server listening on :${PORT}`);
});

// Track open connections so server.close() waits for in-flight requests.
let openConns = 0;
server.on("connection", (socket) => {
  openConns++;
  socket.on("close", () => openConns--);
});

let shuttingDown = false;
const shutdown = async (sig) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] received ${sig}, stopping...`);
  try {
    // Stop accepting new connections, then wait for existing ones to drain.
    await server.close();
    if (openConns > 0) {
      console.log(`[shutdown] waiting for ${openConns} in-flight request(s)`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  } catch {}
  try { acp?.stop?.(); } catch (e) { console.error("[shutdown] acp.stop:", e); }
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
