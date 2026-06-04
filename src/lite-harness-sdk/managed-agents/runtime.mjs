// runtime.mjs — harness resolution, frame translation, and the per-session
// subprocess wrapper. Pure Node, no external deps.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  HttpError,
  agentMessageEvent,
  agentToolUseEvent,
  agentToolResultEvent,
  sessionIdleEvent,
  sessionErrorEvent,
} from "./core.mjs";

// ── harness resolution ───────────────────────────────────────────────────────

/**
 * Validate the requested harness and produce spawn args for the subprocess.
 * @param {string} agent @param {string} [model]
 * @returns {{ agent: string, spawnArgs: string[] }}
 */
export function resolveHarness(agent, model) {
  // No allowlist check: provider auto-discovery in providers/index.mjs is the
  // source of truth. An invalid agent causes server.mjs to exit immediately
  // with "unsupported agent: ...", surfacing as session.status_error.
  if (!agent || typeof agent !== "string") {
    throw new HttpError(400, "agent must be a non-empty string");
  }
  const spawnArgs = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--agent", agent,
  ];
  if (typeof model === "string" && model.length > 0) {
    spawnArgs.push("--model", model);
  }
  return { agent, spawnArgs };
}

// ── frame translation ────────────────────────────────────────────────────────

/**
 * Translate ONE raw NDJSON frame from the subprocess into ZERO OR MORE bare
 * managed-agents events. Never throws on unknown frames — returns [].
 * @param {any} frame @returns {object[]}
 */
export function translateFrame(frame) {
  if (!frame || typeof frame !== "object") return [];

  switch (frame.type) {
    case "system":
    case "control_response":
    case "stream_event":
      return [];

    case "assistant": {
      const content = frame.message?.content;
      if (!Array.isArray(content)) return [];
      const events = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          events.push(agentMessageEvent([{ type: "text", text: block.text }]));
        } else if (block.type === "tool_use") {
          events.push(agentToolUseEvent({ name: block.name, input: block.input, tool_use_id: block.id }));
        }
      }
      return events;
    }

    case "user": {
      const content = frame.message?.content;
      if (!Array.isArray(content)) return [];
      const events = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_result") {
          events.push(agentToolResultEvent({
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          }));
        }
      }
      return events;
    }

    case "result": {
      if (frame.is_error) return [sessionErrorEvent(frame.result || "error during execution")];
      return [sessionIdleEvent({ usage: frame.usage, total_cost_usd: frame.total_cost_usd })];
    }

    default:
      return [];
  }
}

// ── per-session subprocess ───────────────────────────────────────────────────

/**
 * Owns ONE lite-harness subprocess for ONE session. Spawns it, sends the
 * initialize control request, runs a long-lived stdout reader that translates
 * frames and calls emit(event), and serializes user-message writes.
 */
export function createManagedSession({ sessionId, spawnArgs, serverPath, env, emit }) {
  let child = null;
  let alive = false;
  let deliberateKill = false;
  // Per-session turn lock: a promise chain that serializes whole TURNS, not just
  // stdin writes. A turn stays pending until a terminal frame (result ->
  // session.status_idle / session.status_error) settles it, so a second
  // sendUserMessage never writes a user frame while the subprocess is still
  // mid-turn (which it would reject with "A turn is already in progress").
  let tail = Promise.resolve();
  let settleTurn = null;

  function settlePendingTurn() {
    if (settleTurn) {
      const done = settleTurn;
      settleTurn = null;
      done();
    }
  }

  // Emit a translated event, then settle the in-flight turn on a terminal one.
  function emitEvent(ev) {
    emit(ev);
    if (ev.type === "session.status_idle" || ev.type === "session.status_error") {
      settlePendingTurn();
    }
  }

  function start() {
    child = spawn("node", [serverPath, ...spawnArgs], {
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    alive = true;

    // Initialize handshake.
    child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: "req_init",
        request: { subtype: "initialize", hooks: {}, sdk_mcp_servers: [] },
      }) + "\n",
    );

    // Drain stderr, keeping the tail so an unexpected exit can report why.
    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d).slice(-1000);
    });

    // Reader loop over child stdout (NDJSON -> translate -> emit).
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let frame;
      try {
        frame = JSON.parse(trimmed);
      } catch {
        return;
      }
      for (const event of translateFrame(frame)) emitEvent(event);
    });

    let errorEmitted = false;
    function onExit(code, signal) {
      alive = false;
      rl.close();
      // Only a crash (non-zero code or a signal) is an error. A clean exit(0)
      // after a turn must not flip a freshly-idle session to "error".
      const crashed = signal != null || (code != null && code !== 0);
      if (!deliberateKill && !errorEmitted && crashed) {
        errorEmitted = true;
        const reason = signal != null ? `signal ${signal}` : `code ${code}`;
        const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : "";
        emitEvent(sessionErrorEvent(`harness exited (${reason})${detail}`));
      }
      settlePendingTurn(); // unblock the chain even on a silent/deliberate exit
    }
    child.on("exit", onExit);
    child.on("error", (err) => {
      alive = false;
      rl.close();
      if (!deliberateKill && !errorEmitted) {
        errorEmitted = true;
        emitEvent(sessionErrorEvent(`harness error: ${err.message}`));
      }
      settlePendingTurn();
    });
  }

  function sendUserMessage(content) {
    if (!alive) return Promise.reject(new Error("session not alive"));
    const line =
      JSON.stringify({
        type: "user",
        message: { role: "user", content },
        session_id: null,
        parent_tool_use_id: null,
      }) + "\n";
    // Run a whole turn: write the user frame, then keep the lock until the
    // subprocess streams a terminal frame (idle/error) — which settleTurn
    // resolves. `, runTurn` on rejection means a failed turn still lets the
    // next queued message proceed instead of wedging the chain.
    const runTurn = () => {
      if (!alive) return Promise.reject(new Error("session not alive"));
      return new Promise((resolve, reject) => {
        settleTurn = resolve;
        writeOnce(line).catch((err) => {
          if (settleTurn === resolve) settleTurn = null;
          reject(err);
        });
      });
    };
    tail = tail.then(runTurn, runTurn);
    return tail;
  }

  function writeOnce(line) {
    return new Promise((resolve, reject) => {
      if (!child || !child.stdin.writable) return reject(new Error("session not alive"));
      child.stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  function kill() {
    if (deliberateKill) return; // idempotent
    deliberateKill = true;
    alive = false;
    try { child?.stdin?.end(); } catch { /* ignore */ }
    try { child?.kill(); } catch { /* ignore */ }
    settlePendingTurn(); // don't leave a queued sendUserMessage hanging
  }

  function isAlive() {
    return alive;
  }

  return { start, sendUserMessage, kill, isAlive };
}
