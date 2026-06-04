// JSON-RPC 2.0 client over stdio for the Hermes ACP subprocess.
//
// ACP method names — confirm exact spelling against hermes-acp in Phase 0.
// They are isolated here so a naming correction touches only this file.
const METHOD = {
  INITIALIZE: "initialize",
  NEW_SESSION: "session/new",
  PROMPT: "session/prompt",
  CANCEL: "session/cancel",
};

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Spawn hermes-acp, run the initialize handshake, and return a client object.
 * Throws with install instructions if the command is not found.
 */
export async function createAcpClient({ cwd, env = process.env, diagnostics = () => {} }) {
  // Support "node /path/to/script.mjs" style overrides for testing
  const rawCommand = env.HERMES_ACP_COMMAND || "hermes-acp";
  const [command, ...spawnArgs] = rawCommand.split(" ");

  const child = spawn(command, spawnArgs, {
    cwd: cwd || process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let dead = false;
  let nextId = 1;
  const pending = new Map(); // id → { resolve, reject }
  let notificationHandler = null;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => diagnostics(d));

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? null);
    } else if (typeof msg.method === "string" && notificationHandler) {
      notificationHandler(msg.params ?? {});
    }
  });

  function rejectAll(err) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  child.on("error", (err) => {
    dead = true;
    const message = err.code === "ENOENT"
      ? `hermes-acp not found. Install: pip install "hermes-agent[acp]" or uvx hermes-agent[acp]`
      : err.message;
    rejectAll(new Error(message));
  });

  child.on("exit", (code, signal) => {
    dead = true;
    rl.close();
    if (pending.size > 0) {
      const reason = signal != null ? `signal ${signal}` : `exit code ${code}`;
      rejectAll(new Error(`hermes-acp exited unexpectedly (${reason})`));
    }
  });

  function request(method, params) {
    if (dead) return Promise.reject(new Error("hermes-acp is not running"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  // Initialize handshake — also surfaces ENOENT if the command is missing.
  try {
    await request(METHOD.INITIALIZE, {});
  } catch (err) {
    try { child.kill(); } catch { /* ignore */ }
    throw err;
  }

  let acpSessionId = null;
  let cancelFn = null;

  async function newSession({ sessionCwd, mcpServers = [] }) {
    const result = await request(METHOD.NEW_SESSION, {
      cwd: sessionCwd,
      mcp_servers: mcpServers,
    });
    acpSessionId = result?.session_id ?? result?.id ?? "default";
  }

  /**
   * Send a prompt and yield raw ACP notification param objects as they arrive.
   * The caller (runtime) pipes these through transformation.mjs.
   */
  async function* prompt({ text, sessionCwd, mcpServers = [] }) {
    if (!acpSessionId) {
      await newSession({ sessionCwd, mcpServers });
    }

    const queue = [];
    let done = false;
    let promptError = null;
    let wakeup = null;

    function wake() {
      if (wakeup) { const w = wakeup; wakeup = null; w(); }
    }

    notificationHandler = (params) => {
      queue.push(params);
      wake();
    };

    cancelFn = async () => {
      done = true;
      try { await request(METHOD.CANCEL, { session_id: acpSessionId }); } catch { /* ignore */ }
      wake();
    };

    request(METHOD.PROMPT, { session_id: acpSessionId, text })
      .then(() => { done = true; wake(); })
      .catch((err) => { promptError = err; done = true; wake(); });

    try {
      while (!done || queue.length > 0) {
        while (queue.length > 0) {
          yield queue.shift();
        }
        if (!done) {
          await new Promise((r) => { wakeup = r; });
        }
      }
    } finally {
      notificationHandler = null;
      cancelFn = null;
    }

    if (promptError) throw promptError;
  }

  function cancelActivePrompt() {
    cancelFn?.();
  }

  function terminate() {
    dead = true;
    try { rl.close(); } catch { /* ignore */ }
    try { child.stdout.destroy(); } catch { /* ignore */ }
    try { child.stdin.destroy(); } catch { /* ignore */ }
    try { child.stderr.destroy(); } catch { /* ignore */ }
    try { child.unref(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
  }

  return { prompt, cancelActivePrompt, terminate, newSession };
}
