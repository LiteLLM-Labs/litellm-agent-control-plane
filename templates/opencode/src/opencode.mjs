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
// calls through a LiteLLM gateway (via opencode's native Anthropic adapter,
// which POSTs to {baseURL}/messages). Models are addressed as "<id>/<model>".
// Merges into any existing config (preserves mcp). No-op if baseURL/apiKey unset.
export function writeProviderConfig(cwd, { id = "litellm", name = "LiteLLM", baseURL, apiKey, models = [] }) {
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
    obj.provider[id] = {
      npm: "@ai-sdk/anthropic",
      name,
      options: { baseURL, apiKey },
      models: { ...existing, ...Object.fromEntries(models.map((m) => [m, {}])) },
    };
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
        mcp[server.name] = { type: "remote", url: server.url, enabled: true };
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
