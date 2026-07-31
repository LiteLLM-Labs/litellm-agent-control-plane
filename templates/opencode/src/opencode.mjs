// opencode.mjs — manages a child `opencode serve` process and provisions
// per-agent config (agent .md files + opencode.json MCP entries) for an
// opencode-compatible wrapper server. Node 20 ESM, built-ins + global fetch only.

import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// Serialize all opencode.json reads+writes so concurrent agent registrations
// don't clobber each other's models (last-write-wins race condition).
let _jsonQueue = Promise.resolve();
function withJsonLock(fn) {
  const next = _jsonQueue.then(fn, fn);
  _jsonQueue = next.then(() => {}, () => {});
  return next;
}

const execFileP = promisify(execFile);

// opencode only scans custom agents (`.opencode/agent/*.md`) and per-project
// config when the workspace is a git project. Initialise one (idempotent) with
// a single empty commit so opencode detects the project root on boot.
export async function gitInit(cwd) {
  await mkdir(cwd, { recursive: true });
  const run = (args) => execFileP("git", args, { cwd }).catch(() => {});
  await run(["init", "-q"]);
  await run(["config", "user.email", "agent-server@local"]);
  await run(["config", "user.name", "agent-server"]);
  await run(["commit", "-q", "--allow-empty", "-m", "init"]);
}

// Restart the opencode child (stop, wait for the port to free, start again).
// Needed because opencode loads agents + mcp at boot and does NOT hot-reload —
// so after writing new/updated agent config we reboot to pick it up.
export async function restartOpencode(handle, opts) {
  try {
    handle?.stop?.();
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 600));
  return startOpencode(opts);
}

// Write an opencode provider into <cwd>/opencode.json so opencode routes model
// calls through a LiteLLM gateway. Uses a built-in opencode provider (anthropic
// or openai) so no runtime npm install is triggered - the npm field is omitted
// intentionally. Models are addressed as "<id>/<model>".
// Merges into any existing config (preserves mcp). No-op if baseURL/apiKey unset.
// `modelLimits` maps a model id to { context, output } token limits, written as
// opencode's `limit`. Needed for models opencode cannot look up in models.dev
// (any gateway-specific name): without a limit it applies a conservative default
// output budget, and a reasoning model spends the whole budget thinking, then
// returns a response with NO content block. That surfaces as an upstream 500
// ("list index out of range") and an agent turn that ends silently having done
// all of its work. Observed with gemini-3.6-flash; the same request succeeds at
// 75k input tokens once the output budget is generous.
//
// BOTH keys are required: opencode's config schema rejects a `limit` missing
// `context` with ConfigInvalidError. It does so lazily — the server still starts,
// and only session creation fails with a 400 — so an incomplete limit looks like
// a healthy runtime that cannot open a session.
export function writeProviderConfig(cwd, { id = "openai", name = "LiteLLM", baseURL, apiKey, models = [], defaultModel = null, modelLimits = {} }) {
  if (!baseURL || !apiKey) return Promise.resolve();
  return withJsonLock(async () => {
    const file = path.join(cwd, "opencode.json");
    let obj = {};
    try {
      obj = JSON.parse(await readFile(file, "utf8"));
    } catch {
      obj = {};
    }
    obj.provider = obj.provider || {};
    // Merge: preserve any models added by ensureProviderModel so a restart
    // doesn't wipe model entries registered for agents already in SQLite.
    const existing = obj.provider[id]?.models || {};
    const configured = Object.fromEntries(
      models.map((m) => {
        const context = Number(modelLimits[m]?.context);
        const output = Number(modelLimits[m]?.output);
        // Both or neither. A partial limit is worse than none: it passes boot and
        // then fails every session create. Models opencode already knows are left
        // alone so their real ceilings are not capped.
        const usable =
          Number.isFinite(context) && context > 0 && Number.isFinite(output) && output > 0;
        return [m, usable ? { limit: { context, output } } : {}];
      }),
    );
    obj.provider[id] = {
      // No "npm" field: use opencode's built-in provider (no runtime npm install).
      options: { baseURL, apiKey },
      models: { ...existing, ...configured },
    };
    // Set global default so opencode uses a known-good model for ALL internal
    // calls (title generation, summarization, etc.) instead of defaulting to
    // gpt-4o-mini. Prefer explicit defaultModel, then first configured model.
    if (!obj.model) {
      const dm = defaultModel || (models.length ? models[0] : null);
      if (dm) obj.model = dm;
    }
    await mkdir(cwd, { recursive: true });
    await writeFile(file, JSON.stringify(obj, null, 2));
  });
}

export function ensureProviderModel(cwd, { providerID, modelID }) {
  if (!providerID || !modelID) return Promise.resolve();
  return withJsonLock(async () => {
    const file = path.join(cwd, "opencode.json");
    let obj = {};
    try {
      obj = JSON.parse(await readFile(file, "utf8"));
    } catch {
      obj = {};
    }
    const provider = obj.provider?.[providerID];
    if (!provider) return;
    provider.models = provider.models || {};
    if (provider.models[modelID]) return; // already registered, skip write
    provider.models[modelID] = {};
    await mkdir(cwd, { recursive: true });
    await writeFile(file, JSON.stringify(obj, null, 2));
  });
}

// Spawns `opencode serve`, returns once health check passes.
// Returns { baseUrl, proc, stop() }
export async function startOpencode({ port = 4096, cwd, env } = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  // Bind 0.0.0.0 so our loopback health probe connects regardless of the
  // platform's IPv4/IPv6 loopback resolution (a 127.0.0.1-only bind made the
  // in-process fetch hang on some hosts). The port is internal (not exposed).
  const proc = spawn(
    "opencode",
    ["serve", "--port", String(port), "--hostname", "0.0.0.0"],
    { cwd, env: { ...process.env, ...env }, stdio: "inherit" }
  );

  const stop = () => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  };

  return await new Promise((resolve, reject) => {
    let settled = false;
    // Generous deadline: on small/cold instances opencode can take a while to
    // become healthy (it installs provider adapters like @ai-sdk/anthropic).
    const deadline = Date.now() + 120_000;

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to spawn opencode: ${err.message}`));
    });

    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`opencode exited before becoming healthy (code ${code})`));
    });

    const poll = async () => {
      if (settled) return;
      if (Date.now() > deadline) {
        settled = true;
        stop();
        reject(new Error("Timed out waiting for opencode health check"));
        return;
      }
      try {
        // Per-probe timeout so a hung/slow /global/health doesn't wedge the
        // poll (without it the deadline below would never be reached).
        const res = await fetch(`${baseUrl}/global/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.status === 200) {
          settled = true;
          resolve({ baseUrl, proc, stop });
          return;
        }
      } catch {
        /* not up yet */
      }
      setTimeout(poll, 300);
    };

    poll();
  });
}

// Writes <cwd>/.opencode/agent/<agent.id>.md (system prompt + model +
// permissions). MCP servers are written separately by writeMcpConfig so the
// shared opencode.json reflects exactly the union of all agents (no stale
// accumulation across agents).
export async function provisionAgent(cwd, agent) {
  const agentDir = path.join(cwd, ".opencode", "agent");
  await mkdir(agentDir, { recursive: true });

  // Build YAML frontmatter by hand.
  const lines = [];
  lines.push(`description: ${agent?.name || "sandbox agent"}`);
  lines.push("mode: primary");
  if (agent?.model) lines.push(`model: ${agent.model}`);

  const perms = agent?.permissions;
  if (perms && typeof perms === "object" && Object.keys(perms).length) {
    lines.push("permission:");
    for (const [key, value] of Object.entries(perms)) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  const body = agent?.system || "";
  const md = `---\n${lines.join("\n")}\n---\n${body}`;
  const agentFile = path.join(agentDir, `${agent.id}.md`);
  await writeFile(agentFile, md, "utf8");
}

// Rebuild the `mcp` section of <cwd>/opencode.json from the union of all agents'
// mcp_servers. Replacing (not merging) avoids servers from one agent leaking
// into later sessions. Preserves other config (provider, etc.).
/** Case-insensitive check for an auth header opencode would already send. */
function hasAuthHeader(headers) {
  return Object.keys(headers).some((name) => {
    const lower = name.toLowerCase();
    return lower === "authorization" || lower === "x-api-key";
  });
}

/**
 * True when `url` is LAP's *own* MCP proxy endpoint, so it is safe to attach the
 * gateway key.
 *
 * Matching the origin alone is NOT enough: a gateway can be mounted under a path
 * on a shared host (`https://co.example/litellm/v1`), and an unrelated service on
 * that same host (`https://co.example/customer-mcp`) must never receive the
 * gateway key — it may be the master key. So require the URL to sit under LAP's
 * own root AND match one of LAP's actual MCP routes:
 *
 *   {root}/{alias}/mcp                — the dynamic MCP proxy
 *   {root}/mcp/platform/{agent_id}    — platform MCPs (both require a gateway key)
 */
function lapMcpAuth(url) {
  const base = process.env.LITELLM_BASE_URL;
  const key = process.env.LITELLM_API_KEY;
  if (!base || !key) return false;

  let target;
  let root;
  try {
    target = new URL(url);
    root = new URL(base);
  } catch {
    return false;
  }
  if (target.origin !== root.origin) return false;

  // LAP's model API lives at {root}/v1; strip that to get the gateway root.
  const rootPath = root.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  const targetPath = target.pathname.replace(/\/+$/, "");
  if (rootPath && !targetPath.startsWith(`${rootPath}/`)) return false;

  // Only LAP's own MCP routes qualify, relative to the root. An arbitrary
  // same-host path (e.g. /customer-mcp) must not be treated as LAP-owned.
  const rel = targetPath.slice(rootPath.length);
  return /^\/[^/]+\/mcp$/.test(rel) || /^\/mcp\/platform\/[^/]+$/.test(rel);
}

export function writeMcpConfig(cwd, agents) {
  return withJsonLock(async () => {
  const configPath = path.join(cwd, "opencode.json");
  let obj = {};
  try {
    obj = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    obj = {};
  }
  const mcp = {};
  // Preserve the server-level sandbox MCP (not an agent's own server) across rebuilds.
  if (obj.mcp?.sandbox) mcp.sandbox = obj.mcp.sandbox;
  for (const agent of agents || []) {
    for (const server of agent?.mcp_servers || []) {
      if (!server || !server.name || server.name === "sandbox") continue;
      if (server.command) {
        mcp[server.name] = {
          type: "local",
          command: [server.command, ...(server.args || [])],
          enabled: true,
        };
      } else if (server.url) {
        // Forward per-server headers, falling back to the gateway key for MCP
        // endpoints hosted by LAP itself.
        //
        // Why the fallback: LAP's `normalize_mcp_servers` retains ONLY
        // {type,name,url} on each server, so a `headers` object set on the agent
        // never survives the trip to this runtime. LAP's own MCP proxy
        // (`/{alias}/mcp`) nevertheless requires a gateway key, so without this
        // an agent using a LAP-hosted MCP server gets 401. We already hold that
        // key for model calls, so reuse it — but only for LAP's own MCP endpoint,
        // never for third-party (or merely same-host) MCP URLs.
        //
        // Gate on an existing *auth* header rather than on `headers` being
        // non-empty: an entry carrying only something like `x-tenant` still needs
        // credentials, and suppressing the fallback there yields a 401.
        const headers = server.headers && typeof server.headers === "object"
          ? { ...server.headers }
          : {};
        if (!hasAuthHeader(headers) && lapMcpAuth(server.url)) {
          headers.Authorization = `Bearer ${process.env.LITELLM_API_KEY}`;
        }
        mcp[server.name] = {
          type: "remote",
          url: server.url,
          enabled: true,
          ...(Object.keys(headers).length ? { headers } : {}),
        };
      }
    }
  }
  obj.mcp = mcp;
  await mkdir(cwd, { recursive: true });
  await writeFile(configPath, JSON.stringify(obj, null, 2), "utf8");
  }); // end withJsonLock
}

// Wire a sandbox-exec MCP server into opencode.json and DENY native bash/edit so
// the agent runs commands/files through the sandbox (src/sandbox-mcp.mjs) instead
// of the host. Called at boot when a sandbox provider is configured.
export function writeSandboxConfig(cwd, { command, env }) {
  return withJsonLock(async () => {
    const configPath = path.join(cwd, "opencode.json");
    let obj = {};
    try {
      obj = JSON.parse(await readFile(configPath, "utf8"));
    } catch {
      obj = {};
    }
    obj.mcp = obj.mcp || {};
    obj.mcp.sandbox = { type: "local", command, enabled: true, environment: env, timeout: 120_000 };
    obj.permission = { ...(obj.permission || {}), bash: "deny", edit: "deny", "sandbox_*": "allow" };
    await mkdir(cwd, { recursive: true });
    await writeFile(configPath, JSON.stringify(obj, null, 2), "utf8");
  });
}

// Thin proxy helper to the opencode child. Returns the raw fetch Response.
export async function ocFetch(baseUrl, path, init) {
  return fetch(baseUrl + path, init);
}
