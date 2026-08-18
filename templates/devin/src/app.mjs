// app.mjs — Express route wiring for the Anthropic Managed Agents surface,
// backed by a `devin acp` child process speaking ACP over stdio.
//
// Pulled out of index.mjs so routes can be exercised in tests without booting
// a real `devin acp`. All side-effecting collaborators (the agent store, the
// ACP client lifecycle, rule provisioning, model discovery) are injected via
// `deps`.
import express from "express";
import crypto from "node:crypto";

import { devinModelString } from "./models.mjs";
import {
  modelId,
  agentResponse,
  sessionResponse,
  partsFromEvents,
  translateAcpEvent,
  stopReasonEvent,
  runningEvent,
  errorEvent,
} from "./anthropic.mjs";

// A bounded async queue: producers push events; one consumer drains them via
// next(). close() marks end-of-stream and resolves any waiting consumer.
class TurnQueue {
  constructor() {
    this.buffer = [];
    this.waiters = [];
    this.closed = false;
  }
  push(item) {
    if (this.closed) return;
    if (this.waiters.length) {
      this.waiters.shift()(item);
    } else {
      this.buffer.push(item);
    }
  }
  next() {
    if (this.buffer.length) return Promise.resolve(this.buffer.shift());
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  close() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()({ done: true });
  }
}

/**
 * Build the Express app.
 *
 * @param {object} deps
 * @param {object} deps.store                 agent/session store (store.mjs)
 * @param {string} deps.workdir               Devin workspace dir
 * @param {() => Promise<object>} deps.ensureAcp   resolve a live ACP client handle
 * @param {() => boolean} deps.checkAcp            health probe for /health
 * @param {(cwd, agent) => Promise} deps.provisionRule    write a .devin rule
 * @param {(cwd, agentId) => Promise} deps.removeRule     delete a .devin rule
 * @param {(mcpServers) => object[]} deps.toAcpMcpServers map LAP mcp -> ACP mcp
 * @param {() => Promise<object>} deps.listModels         GET /v1/models source
 * @param {Map} [deps.environments]            in-memory environments registry
 */
export function createApp({
  store,
  workdir,
  ensureAcp,
  checkAcp,
  provisionRule,
  removeRule,
  toAcpMcpServers,
  listModels,
  environments = new Map(),
}) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  app.use((req, _res, next) => {
    req.apiKey = req.get("x-api-key") || null;
    req.anthropicVersion = req.get("anthropic-version") || null;
    req.anthropicBeta = req.get("anthropic-beta") || null;
    next();
  });

  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(`[error] ${req.method} ${req.path}:`, err);
      if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
      else try { res.end(); } catch {}
    });

  // ---- per-turn state -----------------------------------------------------
  // sessionId -> { id, queue, terminal, drained, lastActivity }
  const activeTurns = new Map();
  // sessionId -> Set<{resolve, lastTurnId}>
  const turnWaiters = new Map();

  // Clean up completed turns after a grace period so abandoned sessions don't
  // leak memory. Only sweep terminal turns that have no waiting SSE clients.
  const TURN_GRACE_MS = 60_000;
  function sweepCompletedTurns() {
    const now = Date.now();
    for (const [sid, turn] of activeTurns) {
      // Don't delete a turn if a client is still waiting for it.
      const waiters = turnWaiters.get(sid);
      const hasWaiters = waiters && waiters.size > 0;
      if (turn.terminal && !hasWaiters && now - turn.lastActivity > TURN_GRACE_MS) {
        activeTurns.delete(sid);
      }
    }
    for (const [sid, set] of turnWaiters) {
      if (!set.size) turnWaiters.delete(sid);
    }
  }
  setInterval(sweepCompletedTurns, 30_000).unref();

  function wakeTurnWaiters(sessionId) {
    const waiters = turnWaiters.get(sessionId);
    if (!waiters) return;
    for (const w of [...waiters]) {
      const t = activeTurns.get(sessionId);
      if (t && t.id !== w.lastTurnId && !t.drained) {
        waiters.delete(w);
        w.resolve(t);
      }
    }
  }

  function waitForTurn(sessionId, lastTurnId, signal) {
    return new Promise((resolve) => {
      const t = activeTurns.get(sessionId);
      if (t && t.id !== lastTurnId && !t.drained) return resolve(t);
      if (signal.aborted) return resolve(null);
      const waiter = { resolve, lastTurnId };
      let set = turnWaiters.get(sessionId);
      if (!set) { set = new Set(); turnWaiters.set(sessionId, set); }
      set.add(waiter);
      signal.addEventListener(
        "abort",
        () => { set.delete(waiter); resolve(null); },
        { once: true }
      );
    });
  }

  function eventKey(update, out, turnId, chunkSeq) {
    const kind = update?.sessionUpdate;
    if (kind === "agent_message_chunk") {
      // ACP reuses one messageId for chunks from the same message. Include a
      // monotonic chunk sequence to avoid collisions when chunks share the
      // same text prefix.
      return `msg:${update.messageId || ""}:${chunkSeq}:${(out.data?.content?.[0]?.text || "").slice(0, 40)}`;
    }
    if (kind === "tool_call") return `tool:${update.toolCallId || ""}:${update.status || "pending"}`;
    if (kind === "tool_call_update") return `toolupd:${update.toolCallId || ""}:${update.status || ""}`;
    if (kind === "plan") return `plan:${turnId}`;
    return `${out.event}:${JSON.stringify(out.data)}`;
  }

  function persistEvent(sessionId, out, key) {
    store.insertSessionEvent(sessionId, out, key);
  }

  function replayEvent(stored) {
    const data = stored.data || {};
    const id = data.id ?? (stored.seq != null ? `se_${stored.seq}` : undefined);
    return { type: stored.event, ...(id !== undefined ? { id } : {}), ...data };
  }

  // Start a turn: create a queue, register the ACP update handler, fire
  // session/prompt without awaiting (updates stream as notifications), and
  // resolve the terminal event when the prompt response arrives.
  async function startTurn(sessionId, agent, parts) {
    const acp = await ensureAcp();
    // Reject overlapping turns on the same session — they corrupt streaming
    // state by replacing the active turn's queue and handler. Check after
    // ensureAcp to avoid a race window between the check and activeTurns.set.
    const inFlight = activeTurns.get(sessionId);
    if (inFlight && !inFlight.terminal) {
      const err = new Error("a turn is already in flight for this session");
      err.status = 409;
      throw err;
    }
    const model = devinModelString(agent?.model);
    const turnId = "turn_" + crypto.randomBytes(12).toString("hex");
    const queue = new TurnQueue();
    const turn = { id: turnId, queue, terminal: false, drained: false, lastActivity: Date.now(), chunkSeq: 0 };
    activeTurns.set(sessionId, turn);
    wakeTurnWaiters(sessionId);

    // Persist + emit the user's message and a running signal before prompting.
    persistEvent(sessionId, { event: "user.message", data: { content: parts } }, `user:${turnId}`);
    persistEvent(sessionId, runningEvent(), `running:${turnId}`);
    queue.push(runningEvent());

    const handler = (update) => {
      turn.lastActivity = Date.now();
      const out = translateAcpEvent(update, { model });
      if (!out) return;
      const seq = update?.sessionUpdate === "agent_message_chunk" ? turn.chunkSeq++ : 0;
      persistEvent(sessionId, out, eventKey(update, out, turnId, seq));
      queue.push(out);
    };
    acp.registerSession(sessionId, handler);

    // Fire the prompt; resolve the terminal event when the turn ends.
    acp
      .call("session/prompt", { sessionId, prompt: parts })
      .then((result) => {
        const ev = stopReasonEvent(result?.stopReason);
        persistEvent(sessionId, ev, `idle:${turnId}`);
        queue.push(ev);
        turn.terminal = true;
        queue.close();
        // Only unregister if this turn is still the active one — a newer turn
        // may have started if the client sent another prompt after this one
        // was rejected.
        if (activeTurns.get(sessionId) === turn) acp.unregisterSession(sessionId);
      })
      .catch((err) => {
        const ev = errorEvent(err?.message || "prompt failed");
        persistEvent(sessionId, ev, `error:${turnId}`);
        queue.push(ev);
        turn.terminal = true;
        queue.close();
        if (activeTurns.get(sessionId) === turn) acp.unregisterSession(sessionId);
      });

    return turn;
  }

  // ---- agents -------------------------------------------------------------
  // Provision the agent's system prompt as a Devin rule file. No child reboot
  // is needed — `devin acp` reads .devin/rules per session on session/new.
  async function applyAgent(row) {
    if (row) await provisionRule(workdir, row);
  }

  // ---- health -------------------------------------------------------------
  // /health is the liveness probe — always returns 200 as long as the
  // process is running. Use /ready for readiness checks (returns 503
  // when the ACP child is not alive).
  app.get("/health", wrap(async (_req, res) => {
    let devin = false;
    try { devin = !!checkAcp(); } catch { devin = false; }
    res.json({ ok: true, devin });
  }));

  app.get("/ready", wrap(async (_req, res) => {
    let devin = false;
    try { devin = !!checkAcp(); } catch { devin = false; }
    if (!devin) return res.status(503).json({ ok: false, devin: false });
    res.json({ ok: true, devin: true });
  }));

  app.get("/v1/models", wrap(async (_req, res) => {
    res.json(await listModels());
  }));

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
    await applyAgent(row);
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

  app.patch("/v1/agents/:id", wrap(async (req, res) => {
    const patch = {};
    if (req.body?.name !== undefined) patch.name = req.body.name;
    if (req.body?.system !== undefined) patch.system = req.body.system;
    if (req.body?.model !== undefined) patch.model = modelId(req.body.model);
    if (req.body?.permissions !== undefined) patch.permissions = req.body.permissions;
    if (req.body?.mcp_servers !== undefined) patch.mcp_servers = req.body.mcp_servers;
    const row = store.updateAgent(req.params.id, patch);
    if (!row) return res.status(404).json({ error: "agent not found" });
    await applyAgent(row);
    res.json(agentResponse(row));
  }));

  app.delete("/v1/agents/:id", wrap(async (req, res) => {
    const deleted = store.deleteAgent(req.params.id);
    if (!deleted) return res.status(404).json({ error: "agent not found" });
    try { await removeRule(workdir, req.params.id); } catch (e) {
      console.error(`[agent] removeRule failed for ${req.params.id}:`, e?.message || e);
    }
    res.status(204).end();
  }));

  // ---- environments -------------------------------------------------------
  app.post("/v1/environments", wrap(async (req, res) => {
    const { name, config } = req.body || {};
    const id = "env_" + crypto.randomBytes(16).toString("hex");
    environments.set(id, config || {});
    res.json({ id, type: "environment", name, config: config || {} });
  }));

  // ---- sessions -----------------------------------------------------------
  app.post("/v1/sessions", wrap(async (req, res) => {
    const row = store.getAgent(req.body?.agent);
    if (!row) return res.status(400).json({ error: "unknown agent" });

    const acp = await ensureAcp();
    const mcpServers = toAcpMcpServers(row.mcp_servers);
    let result;
    try {
      result = await acp.call("session/new", { cwd: workdir, mcpServers });
    } catch (err) {
      return res.status(502).json({ error: `devin session/new failed: ${err?.message || err}` });
    }
    const sid = result?.sessionId;
    if (!sid) return res.status(502).json({ error: "devin session/new response missing sessionId" });

    store.bindSession(sid, row.id);

    // Apply the agent's model to this session if Devin exposes a model config
    // option. Best-effort: ignore failures (Devin falls back to its default).
    const model = devinModelString(row.model);
    if (model) {
      try {
        await acp.call("session/set_config_option", { sessionId: sid, configId: "model", value: model });
      } catch (e) {
        console.warn(`[session] set_config_option(model=${model}) failed: ${e?.message || e}`);
      }
    }

    res.json(sessionResponse({ id: sid, agentId: row.id, environmentId: req.body.environment_id }));
  }));

  app.post("/v1/sessions/:id/events", wrap(async (req, res) => {
    const agentId = store.getSessionAgent(req.params.id);
    if (!agentId) return res.status(404).json({ error: "unknown session" });
    const agent = store.getAgent(agentId);

    const parts = partsFromEvents(req.body?.events || []);
    if (!parts.length) return res.status(400).json({ error: "no user.message parts" });

    try {
      await startTurn(req.params.id, agent, parts);
    } catch (err) {
      if (err.status === 409) return res.status(409).json({ error: err.message });
      return res.status(502).json({ error: `devin prompt failed: ${err?.message || err}` });
    }
    res.status(202).json({ ok: true });
  }));

  app.post("/v1/sessions/:id/abort", wrap(async (req, res) => {
    try {
      const acp = await ensureAcp();
      acp.notify("session/cancel", { sessionId: req.params.id });
      res.json({ aborted: true });
    } catch (err) {
      res.status(502).json({ aborted: false, error: String(err?.message || err) });
    }
  }));

  app.get("/v1/sessions/:id/events", wrap(async (req, res) => {
    res.json({ data: store.listSessionEvents(req.params.id).map(replayEvent) });
  }));

  // Live SSE stream: drains per-turn queues of translated ACP events.
  // Enforce a single active stream per session — the TurnQueue is
  // single-consumer; multiple readers would split events.
  const activeStreams = new Set();
  app.get("/v1/sessions/:id/events/stream", wrap(async (req, res) => {
    const sid = req.params.id;
    if (activeStreams.has(sid)) {
      return res.status(409).json({ error: "an SSE stream is already open for this session" });
    }
    activeStreams.add(sid);
    req.on("close", () => activeStreams.delete(sid));

    const agentId = store.getSessionAgent(sid);
    const agent = agentId ? store.getAgent(agentId) : null;
    const model = devinModelString(agent?.model);

    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    const writeSse = (out) => {
      try {
        res.write(`event: ${out.event}\ndata: ${JSON.stringify(out.data)}\n\n`);
      } catch {}
    };

    // Keep the connection alive during long thinking turns with no events.
    const keepalive = setInterval(() => {
      try { res.write(`: keepalive\n\n`); } catch {}
    }, 15_000);
    req.on("close", () => clearInterval(keepalive));

    try {
      let lastTurnId = null;
      while (!controller.signal.aborted) {
        // Join the current turn if one is in flight (covers the stream-opened-
        // before-post case), otherwise wait for the next turn to start.
        let turn = activeTurns.get(req.params.id);
        if (!turn || turn.id === lastTurnId || turn.drained) {
          turn = await waitForTurn(req.params.id, lastTurnId, controller.signal);
          if (!turn) break; // client disconnected
        }
        // Drain this turn's queue until it closes (terminal event pushed).
        while (!controller.signal.aborted) {
          const item = await turn.queue.next();
          if (item?.done) break;
          writeSse(item);
        }
        lastTurnId = turn.id;
        turn.drained = true;
      }
    } catch (err) {
      if (err?.name !== "AbortError" && !controller.signal.aborted) {
        console.error(`[stream] ${req.params.id}:`, err);
      }
    } finally {
      try { res.end(); } catch {}
    }
  }));

  return app;
}
