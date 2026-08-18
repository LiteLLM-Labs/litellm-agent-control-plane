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
        respond(msg.id, {
          outcome: { outcome: "selected", optionId: "allow-once" },
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
      alive = false;
      killPending(err);
      throw new Error(`ACP stdin write failed: ${err?.message || err}`);
    }
  }

  function request(method, params) {
    const id = nextId();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(method, params) {
    send({ jsonrpc: "2.0", method, params });
  }

  function respond(id, result, error) {
    const obj = { jsonrpc: "2.0", id };
    if (error) obj.error = error;
    else obj.result = result ?? null;
    send(obj);
  }

  proc.on("error", (err) => {
    alive = false;
    killPending(err);
    emitter.emit("dead", err);
  });
  proc.on("exit", (code) => {
    alive = false;
    killPending(new Error(`devin acp exited (code ${code})`));
    emitter.emit("dead", new Error(`devin acp exited (code ${code})`));
  });

  // ---- initialize handshake ---------------------------------------------
  const initResult = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      // This server does not provide a client filesystem or terminal to the
      // agent — Devin owns its own workspace. Omitted capabilities are
      // treated as unsupported per the ACP spec.
    },
    clientInfo: { name: clientName, version: "0.1.0" },
  });

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
