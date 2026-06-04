// JSON-RPC 2.0 client over stdio for the Hermes ACP subprocess.
//
// Method names from acp/meta.py (schema ref: v0.11.2):
//   initialize       → request
//   session/new      → request
//   session/prompt   → request  (prompt is an array of content blocks)
//   session/cancel   → notification (NO id, NO response — fire and forget)
//   session/update   → notification FROM server (streaming chunks)
//
// Field names on the wire are camelCase (Pydantic aliases), e.g.:
//   sessionId, mcpServers, protocolVersion, clientCapabilities, sessionUpdate

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export async function createAcpClient({ cwd, env = process.env, diagnostics = () => {} }) {
  // Support "node /path/to/script.mjs" style overrides for testing
  const rawCommand = env.HERMES_ACP_COMMAND || "hermes-acp";
  const [command, ...spawnArgs] = rawCommand.split(" ");

  // Strip HERMES_ACP_COMMAND from the child env so hermes-acp doesn't inherit
  // our own internal env var (it has no meaning for the Python process).
  const { HERMES_ACP_COMMAND: _ignored, ...childEnv } = env;

  const child = spawn(command, spawnArgs, {
    cwd: cwd || process.cwd(),
    env: childEnv,
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
      // Response to a pending request
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? null);
    } else if (typeof msg.method === "string") {
      // Server notification (no id) — route to active prompt stream
      if (notificationHandler) notificationHandler(msg.method, msg.params ?? {});
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

  // Notifications: no id, no response expected
  function notify(method, params) {
    if (dead) return;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  // Wait for hermes-acp's Python asyncio event loop to fully start.
  // hermes-acp takes ~1s from spawn to "ACP client connected" on typical hardware.
  // A fixed delay is simpler and more robust than trying to detect readiness
  // via stderr (which depends on log format that can change across versions).
  await new Promise((r) => setTimeout(r, 1200));

  // Initialize handshake — also surfaces ENOENT if the command is missing.
  // protocolVersion: 1 is required by InitializeRequest.
  try {
    await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  } catch (err) {
    try { child.kill(); } catch { /* ignore */ }
    throw err;
  }

  let acpSessionId = null;
  let cancelFn = null;

  async function newSession({ sessionCwd, mcpServers = [] }) {
    const result = await request("session/new", {
      cwd: sessionCwd || process.cwd(),
      mcpServers,                           // camelCase on the wire
    });
    // NewSessionResponse uses sessionId (camelCase)
    acpSessionId = result?.sessionId ?? result?.session_id ?? "default";
  }

  /**
   * Send a prompt and yield raw ACP session update objects as they arrive.
   * The caller (runtime) pipes these through transformation.mjs.
   *
   * Real PromptRequest shape:
   *   { sessionId: "...", prompt: [{ type: "text", text: "..." }] }
   *
   * Server sends session/update notifications:
   *   { method: "session/update", params: { sessionId: "...", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "..." } } } }
   *
   * session/cancel is a notification (no id, no response):
   *   { method: "session/cancel", params: { sessionId: "..." } }
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

    notificationHandler = (method, params) => {
      if (method === "session/update") {
        queue.push(params);
        wake();
      }
    };

    cancelFn = () => {
      done = true;
      // session/cancel is a notification — no id, no await
      notify("session/cancel", { sessionId: acpSessionId });
      wake();
    };

    request("session/prompt", {
      sessionId: acpSessionId,              // camelCase on the wire
      prompt: [{ type: "text", text }],     // array of content blocks
    })
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
