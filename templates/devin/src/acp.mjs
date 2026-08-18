// acp.mjs — minimal Agent Client Protocol (ACP) client over stdio.
//
// Spawns `devin acp` as a child process and speaks newline-delimited JSON-RPC
// 2.0 on its stdin/stdout. ACP is turn-based: `session/prompt` is a blocking
// request whose progress arrives as `session/update` notifications on the same
// connection. This client routes those notifications to per-session handlers
// registered by the caller, and auto-responds to `session/request_permission`
// (this server is headless — permission policy is set via Devin's permission
// mode, not interactive prompts).
//
// No external deps. Node 20 ESM, built-ins only.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

let _id = 0;
function nextId() {
  _id += 1;
  return _id;
}

// Start an ACP server subprocess and perform the `initialize` handshake.
// Returns a handle: { call, notify, onSessionUpdate, registerSession, unregisterSession, alive, stop, onDead }.
//
// opts:
//   cwd            working directory for the `devin acp` child (the agent's workspace)
//   model          optional default model passed as `devin acp --model <model>`
//   agentType      optional `--agent-type <TYPE>`
//   permissionMode optional; not a devin-acp flag (set via config option per session)
//   env            extra env for the child (defaults to process.env)
//   binary         devin binary path (default: "devin")
//   clientName     clientInfo.name for initialize (default: "devin-agent-server")
export async function startAcp({
  cwd,
  model = null,
  agentType = null,
  env = {},
  binary = "devin",
  clientName = "devin-agent-server",
} = {}) {
  const args = ["acp"];
  if (model) args.push("--model", model);
  if (agentType) args.push("--agent-type", agentType);

  const proc = spawn(binary, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });

  // A write after the child exits emits EPIPE on stdin; an unhandled stream
  // error would crash the process. Route stdin errors through the transport-
  // death cleanup path so pending calls reject and the ACP child restarts.
  proc.stdin.on("error", (err) => {
    console.error("[acp] stdin error:", err?.message || err);
    markDead(err);
  });

  const emitter = new EventEmitter();
  // sessionId -> (update) => void
  const updateHandlers = new Map();
  // id -> {resolve, reject, method}
  const pending = new Map();
  let alive = true;
  let buffer = "";

  const killPending = (err) => {
    for (const { reject, method } of pending.values()) {
      reject(new Error(`ACP transport closed while waiting for ${method}: ${err?.message || ""}`));
    }
    pending.clear();
  };

  // Single death-transition helper — prevents double emission when stdin
  // error and child exit fire in sequence.
  function markDead(err) {
    if (!alive) return;
    alive = false;
    killPending(err);
    emitter.emit("dead", err);
  }

  // stdout is newline-delimited JSON-RPC. Buffer partial lines and dispatch.
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        console.error("[acp] unparseable stdout line:", line.slice(0, 400));
        continue;
      }
      dispatch(msg);
    }
  });

  function dispatch(msg) {
    // Response to one of our requests.
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(toRpcError(msg.error));
      else p.resolve(msg.result);
      return;
    }
    // A server -> client request (has method + id) or notification (method, no id).
    if (msg.method) {
      // Permission requests: auto-allow (headless server). Policy is enforced
      // by Devin's permission mode, not interactive prompts.
      if (msg.method === "session/request_permission" && msg.id != null) {
        // Auto-allow in headless mode. Select an available allow option from
        // the request's options list rather than hardcoding "allow-once",
        // since agents may use different option IDs.
        const options = msg.params?.options || [];
        const allow = options.find(
          (o) => o.kind === "allow_once" || o.kind === "allow_always" || o.optionId?.startsWith("allow")
        );
        // Only select an allow option; never auto-select a deny/cancel option.
        respond(msg.id, {
          outcome: allow
            ? { outcome: "selected", optionId: allow.optionId }
            : { outcome: "cancelled" },
        });
        return;
      }
      // session/update notifications route to the per-session handler.
      if (msg.method === "session/update") {
        const sid = msg.params?.sessionId;
        const handler = sid != null ? updateHandlers.get(sid) : null;
        if (handler) {
          try {
            handler(msg.params?.update, msg.params);
          } catch (e) {
            console.error(`[acp] session/update handler error for ${sid}:`, e);
          }
        }
        return;
      }
      // Other server-initiated notifications: ignore (elicitation/complete, etc.).
      if (msg.id == null) return;
      // Unknown server request: respond method not found.
      respond(msg.id, undefined, { code: -32601, message: `method not found: ${msg.method}` });
    }
  }

  function toRpcError(err) {
    const e = new Error(err?.message || "ACP error");
    e.code = err?.code;
    e.data = err?.data;
    return e;
  }

  function send(obj) {
    if (!alive) throw new Error("ACP transport is not alive");
    // ACP stdio: messages MUST NOT contain embedded newlines.
    try {
      proc.stdin.write(JSON.stringify(obj) + "\n");
    } catch (err) {
      // Route through markDead so the dead event fires exactly once and
      // pending requests are rejected consistently.
      markDead(new Error(`ACP stdin write failed: ${err?.message || err}`));
      throw new Error(`ACP stdin write failed: ${err?.message || err}`);
    }
  }

  function request(method, params, timeoutMs = 0) {
    const id = nextId();
    return new Promise((resolve, reject) => {
      let timer = null;
      const settle = {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
        method,
      };
      pending.set(id, settle);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ACP request timed out after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
      }
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(e);
      }
    });
  }

  function notify(method, params) {
    send({ jsonrpc: "2.0", method, params });
  }

  function respond(id, result, error) {
    if (!alive) return; // Don't try to respond after transport death.
    const obj = { jsonrpc: "2.0", id };
    if (error) obj.error = error;
    else obj.result = result ?? null;
    send(obj);
  }

  proc.on("error", (err) => markDead(err));
  proc.on("exit", (code) => markDead(new Error(`devin acp exited (code ${code})`)));

  // ---- initialize handshake ---------------------------------------------
  let initResult;
  try {
    initResult = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        // This server does not provide a client filesystem or terminal to the
        // agent — Devin owns its own workspace. Omitted capabilities are
        // treated as unsupported per the ACP spec.
      },
      clientInfo: { name: clientName, version: "0.1.0" },
    }, 30_000);
  } catch (e) {
    // Kill the child on handshake failure so we don't leak orphaned processes.
    try { proc.kill("SIGTERM"); } catch {}
    alive = false;
    throw e;
  }

  return {
    proc,
    initResult,
    isAlive: () => alive,
    onDead: (fn) => emitter.on("dead", fn),

    // Send a JSON-RPC request and await its result.
    call: (method, params) => request(method, params),
    // Send a fire-and-forget notification (e.g. session/cancel).
    notify,

    // Register/unregister a handler for session/update notifications on a
    // given sessionId. While registered, every update for that session is
    // delivered to `handler(update, params)`.
    registerSession: (sessionId, handler) => updateHandlers.set(sessionId, handler),
    unregisterSession: (sessionId) => updateHandlers.delete(sessionId),

    stop: () => {
      try {
        proc.stdin.end();
      } catch {}
      try {
        proc.kill("SIGTERM");
      } catch {}
    },
  };
}
