// app.mjs — Express route wiring for the Anthropic Managed Agents surface.
//
// Pulled out of index.mjs so the routes can be exercised in tests without
// booting a real `opencode serve`. All side-effecting collaborators (the agent
// store, the opencode child lifecycle, provider config writers) are injected via
// `deps`, so a test can hand in fakes while index.mjs wires in the real ones.
import express from "express";
import crypto from "node:crypto";

import { opencodeModel, opencodeModelString } from "./models.mjs";
import {
  modelId,
  agentResponse,
  sessionResponse,
  partsFromEvents,
  translateOpencodeEvent,
} from "./anthropic.mjs";

/**
 * Build the Express app.
 *
 * @param {object} deps
 * @param {object} deps.store                 agent/session store (see store.mjs)
 * @param {string} deps.workdir               opencode workspace dir
 * @param {string|null} deps.defaultModelProviderID  provider for bare model names
 * @param {string} deps.litellmProviderID     provider id treated as LiteLLM
 * @param {(cwd, model) => Promise} deps.ensureProviderModel  register a model in opencode.json
 * @param {(cwd, agent) => Promise} deps.provisionAgent       write the agent .md
 * @param {(cwd, agents) => Promise} deps.writeMcpConfig      rebuild mcp section
 * @param {() => Promise} deps.rebootOpencode  restart opencode to load config
 * @param {() => Promise<string>} deps.ocBase  resolve the opencode base url
 * @param {(baseUrl, path, init?) => Promise} deps.ocFetch    fetch against opencode
 * @param {() => Promise<boolean>} deps.checkOpencode  health probe for /health
 * @param {Map} [deps.environments]            in-memory environments registry
 */
export function createApp({
  store,
  workdir,
  defaultModelProviderID,
  litellmProviderID,
  listModels = async () => ({ object: "list", data: [] }),
  ensureProviderModel,
  provisionAgent,
  writeMcpConfig,
  rebootOpencode,
  ocBase,
  ocFetch,
  checkOpencode,
  environments = new Map(),
}) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  // Honor (but don't strictly require) Anthropic-style headers.
  app.use((req, _res, next) => {
    req.apiKey = req.get("x-api-key") || null;
    req.anthropicVersion = req.get("anthropic-version") || null;
    req.anthropicBeta = req.get("anthropic-beta") || null;
    next();
  });

  // Wrap async handlers so throws become 500 {error}.
  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(`[error] ${req.method} ${req.path}:`, err);
      if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
      else try { res.end(); } catch {}
    });

  const activeTurns = new Map();

  function rawSessionId(raw) {
    return (
      raw?.properties?.sessionID ??
      raw?.sessionID ??
      raw?.properties?.session_id ??
      raw?.properties?.info?.sessionID ??
      raw?.properties?.part?.sessionID ??
      raw?.properties?.message?.sessionID ??
      null
    );
  }

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function eventKey(raw, out, turnId) {
    const props = raw?.properties || raw || {};
    if (props.id != null) return `raw:${props.id}`;

    const data = out?.data || {};
    if (data.id != null) return `${out.event}:id:${data.id}`;
    if (data.messageID != null || data.partID != null) {
      return `${out.event}:message:${data.messageID || ""}:part:${data.partID || ""}:${stableJson(data)}`;
    }
    if (data.tool_use_id != null) return `${out.event}:tool:${data.tool_use_id}:${stableJson(data)}`;

    const sid = rawSessionId(raw) || data.sessionID || "";
    if (turnId) return `turn:${turnId}:${out.event}:${stableJson(data)}`;
    if (sid) return `session:${sid}:${out.event}:${stableJson(data)}`;
    return `${out.event}:${stableJson(data)}`;
  }

  function replayEvent(stored) {
    const data = stored.data || {};
    // A unique id per replayed event so downstream stores that dedup by id
    // (the platform's Postgres event cache) never collapse distinct events
    // with identical payloads (e.g. repeated identical text deltas).
    const id = data.id ?? (stored.seq != null ? `se_${stored.seq}` : undefined);
    return { type: stored.event, ...(id !== undefined ? { id } : {}), ...data };
  }

  function terminalEvent(event) {
    return event === "session.status_idle" || event === "session.error";
  }

  function shouldPersistEvent(sessionId, turnId, raw, out) {
    const sid = rawSessionId(raw);
    if (sid != null) return sid === sessionId;
    if (!out?.event?.startsWith("session.")) return true;

    const turn = activeTurns.get(sessionId);
    if (!turn || turn.id !== turnId) return false;
    return Array.from(activeTurns.values()).filter((t) => !t.terminal).length <= 1;
  }

  function persistEvent(sessionId, raw, out, turnId) {
    if (!shouldPersistEvent(sessionId, turnId, raw, out)) return false;
    store.insertSessionEvent(sessionId, out, eventKey(raw, out, turnId));
    if (terminalEvent(out.event)) {
      const turn = activeTurns.get(sessionId);
      if (turn?.id === turnId) turn.terminal = true;
    }
    return true;
  }

  function captureFailure(sessionId, turnId, message) {
    const out = { event: "session.error", data: { error: { message } } };
    store.insertSessionEvent(sessionId, out, `turn:${turnId}:capture-error:${message}`);
    const turn = activeTurns.get(sessionId);
    if (turn?.id === turnId) turn.terminal = true;
  }

  function parseSseData(block) {
    return block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
  }

  // If opencode stops emitting events mid-turn without a terminal event (its
  // idle signal varies across versions), synthesize session.status_idle after
  // this much silence so the client never hangs in "running" forever.
  const IDLE_FALLBACK_MS = Number(process.env.TURN_IDLE_FALLBACK_MS || 30_000);
  // DEBUG_EVENTS=1 logs every raw opencode event the capture loop sees -
  // verbose, but invaluable to learn the exact event shapes a given opencode
  // version emits (e.g. what its end-of-turn signal looks like).
  const DEBUG_EVENTS = process.env.DEBUG_EVENTS === "1";

  // ---- global event pump ----------------------------------------------------
  // ONE permanent subscription to opencode's /event feed, persisting translated
  // events for every bound session. Replaces the old per-turn capture loops,
  // which silently lost events whenever their ephemeral SSE connection raced an
  // opencode reboot or died mid-turn (observed: turn messages persisted but the
  // terminal idle dropped, leaving clients in "running" forever).
  let pumpStarted = false;
  let pumpConnected = false;

  function pumpHandle(raw) {
    const sid = rawSessionId(raw);
    if (!sid) return;
    const agentId = store.getSessionAgent(sid);
    if (!agentId) return; // not one of our sessions
    const turn = activeTurns.get(sid);
    if (turn && !turn.terminal) turn.lastActivity = Date.now();
    const agent = store.getAgent(agentId);
    const out = translateOpencodeEvent(raw, { sessionId: sid, model: agent?.model || null });
    if (!out) return;
    // Drop stray running/idle outside an open turn (e.g. opencode internal ops
    // like title generation): a stray "running" persisted after the turn's
    // final idle would wedge the platform's status reconciliation.
    const lifecycle = out.event === "session.status_running" || out.event === "session.status_idle";
    if (lifecycle && (!turn || turn.terminal)) return;
    persistEvent(sid, raw, out, turn?.id ?? null);
  }

  function ensureEventPump() {
    if (pumpStarted) return;
    pumpStarted = true;
    (async () => {
      for (;;) {
        try {
          const upstream = await ocFetch(await ocBase(), "/event", {});
          if (!upstream.ok || !upstream.body) {
            throw new Error(`opencode /event unavailable (${upstream.status || "no body"})`);
          }
          pumpConnected = true;
          console.log("[pump] subscribed to opencode /event");
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of upstream.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const block = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const data = parseSseData(block);
              if (!data) continue;
              let ev;
              try { ev = JSON.parse(data); } catch { continue; }
              if (DEBUG_EVENTS) console.log("[events]", data.slice(0, 800));
              pumpHandle(ev);
            }
          }
          console.warn("[pump] opencode /event stream ended (reboot?), reconnecting");
        } catch (err) {
          console.error("[pump] /event stream error:", err?.message || err);
        }
        pumpConnected = false;
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
  }

  async function waitForPump(timeoutMs = 15_000) {
    ensureEventPump();
    const deadline = Date.now() + timeoutMs;
    while (!pumpConnected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return pumpConnected;
  }

  // Per-turn inactivity watchdog: if the pump sees no events for this session
  // for IDLE_FALLBACK_MS while a turn is open, synthesize the terminal idle so
  // clients never hang in "running" forever (e.g. opencode died mid-turn).
  function armTurnWatchdog(sessionId, turnId) {
    const watchdog = setInterval(() => {
      const turn = activeTurns.get(sessionId);
      if (!turn || turn.id !== turnId || turn.terminal) {
        clearInterval(watchdog);
        return;
      }
      if (Date.now() - turn.lastActivity < IDLE_FALLBACK_MS) return;
      console.warn(`[watchdog] ${sessionId}: no events for ${IDLE_FALLBACK_MS}ms, synthesizing idle`);
      store.insertSessionEvent(
        sessionId,
        { event: "session.status_idle", data: { stop_reason: { type: "end_turn" } } },
        `turn:${turnId}:idle-fallback`
      );
      turn.terminal = true;
      clearInterval(watchdog);
    }, 2000);
  }

  // ---- agents -------------------------------------------------------------
  // Write an agent's config to disk and reboot opencode so it loads (opencode
  // has no hot-reload). The mcp section is rebuilt from ALL agents so one
  // agent's servers never leak into another's sessions. When the agent's model
  // is a bare name routed at the LiteLLM provider, register it in opencode.json
  // BEFORE provisioning so opencode knows about it on the reboot below.
  async function applyAgentsAndReboot(provisionRow) {
    if (provisionRow) {
      const model = opencodeModel(provisionRow.model, defaultModelProviderID);
      if (model?.providerID === litellmProviderID) {
        await ensureProviderModel(workdir, model);
      }
      await provisionAgent(workdir, {
        ...provisionRow,
        model: opencodeModelString(provisionRow.model, defaultModelProviderID),
      });
    }
    await writeMcpConfig(workdir, store.listAgents());
    await rebootOpencode();
  }

  // ---- health -------------------------------------------------------------
  // Non-blocking: report opencode readiness WITHOUT awaiting a (possibly slow)
  // boot. The web server is healthy as soon as the port is up.
  app.get("/health", wrap(async (_req, res) => {
    let opencode = false;
    try {
      opencode = !!(await checkOpencode());
    } catch {
      opencode = false;
    }
    res.json({ ok: true, opencode });
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
    await applyAgentsAndReboot(row);
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

  // Update an agent (e.g. change the system prompt or add MCP servers), rewrite
  // its config, and reboot opencode to apply.
  app.patch("/v1/agents/:id", wrap(async (req, res) => {
    const patch = {};
    if (req.body?.name !== undefined) patch.name = req.body.name;
    if (req.body?.system !== undefined) patch.system = req.body.system;
    if (req.body?.model !== undefined) patch.model = modelId(req.body.model);
    if (req.body?.permissions !== undefined) patch.permissions = req.body.permissions;
    if (req.body?.mcp_servers !== undefined) patch.mcp_servers = req.body.mcp_servers;
    const row = store.updateAgent(req.params.id, patch);
    if (!row) return res.status(404).json({ error: "agent not found" });
    await applyAgentsAndReboot(row);
    res.json(agentResponse(row));
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

    const r = await ocFetch(await ocBase(), "/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: req.body.title || row.name + " session" }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res
        .status(502)
        .json({ error: `opencode session create failed (${r.status})`, detail: detail.slice(0, 500) });
    }
    const ses = await r.json().catch(() => ({}));
    const sid = ses.id;
    if (!sid) {
      return res.status(502).json({ error: "opencode session response missing id" });
    }

    store.bindSession(sid, row.id);

    res.json(
      sessionResponse({
        id: sid,
        agentId: row.id,
        environmentId: req.body.environment_id,
      })
    );
  }));

  // Submit events (user.message parts) -> opencode prompt_async. The model is
  // taken from the session's bound agent and normalized to opencode's
  // provider/model object so the selected model drives the turn.
  app.post("/v1/sessions/:id/events", wrap(async (req, res) => {
    const agentId = store.getSessionAgent(req.params.id);
    const agent = agentId ? store.getAgent(agentId) : null;

    const parts = partsFromEvents(req.body?.events || []);
    if (!parts.length) return res.status(400).json({ error: "no user.message parts" });

    // The pump must be subscribed before prompting so no early events are lost.
    if (!(await waitForPump())) {
      return res.status(502).json({ error: "opencode event stream unavailable" });
    }

    const turnId = "turn_" + crypto.randomBytes(12).toString("hex");
    activeTurns.set(req.params.id, { id: turnId, terminal: false, lastActivity: Date.now() });

    // Persist the user's message before prompting so the turn always starts
    // with it in the replay, regardless of how fast agent events arrive.
    store.insertSessionEvent(req.params.id, {
      event: "user.message",
      data: { content: parts },
    }, `user:${turnId}`);

    const r = await ocFetch(await ocBase(), `/session/${req.params.id}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // Select the agent loaded from disk so opencode applies its system
        // prompt, tool permissions, and MCP servers.
        agent: agentId || undefined,
        model: opencodeModel(agent?.model, defaultModelProviderID),
        parts,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      captureFailure(req.params.id, turnId, `opencode prompt failed (${r.status})`);
      return res
        .status(502)
        .json({ error: `opencode prompt failed (${r.status})`, detail: detail.slice(0, 500) });
    }

    armTurnWatchdog(req.params.id, turnId);

    res.status(202).json({ ok: true });
  }));

  // Interrupt the in-flight turn — proxies opencode's session abort.
  app.post("/v1/sessions/:id/abort", wrap(async (req, res) => {
    const r = await ocFetch(await ocBase(), `/session/${req.params.id}/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    res.status(r.ok ? 200 : r.status).json({ aborted: r.ok });
  }));

  app.get("/v1/sessions/:id/events", wrap(async (req, res) => {
    res.json({ data: store.listSessionEvents(req.params.id).map(replayEvent) });
  }));

  // Live SSE stream: opencode events -> Anthropic event shapes.
  app.get("/v1/sessions/:id/events/stream", wrap(async (req, res) => {
    const agentId = store.getSessionAgent(req.params.id);
    const agent = agentId ? store.getAgent(agentId) : null;
    const model = agent?.model || null;

    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    // Mirror watchdog-synthesized idle to live stream clients: the synthetic
    // event only lands in the store, never on opencode's /event feed, so
    // without this the platform's live stream would stay "running" forever.
    const idleFrame = () =>
      `event: session.status_idle\ndata: ${JSON.stringify({ stop_reason: { type: "end_turn" } })}\n\n`;
    const mirroredTurns = new Set();
    const startingTurn = activeTurns.get(req.params.id);
    if (startingTurn?.terminal) {
      // The turn already finished (e.g. watchdog fired while no stream was
      // connected): tell the reconnecting client immediately so it doesn't
      // wait forever for an idle that already happened.
      mirroredTurns.add(startingTurn.id);
      try { res.write(idleFrame()); } catch {}
    }
    const idleMirror = setInterval(() => {
      const turn = activeTurns.get(req.params.id);
      // Emit idle once per turn that reaches terminal state while this stream
      // is connected (covers turns finished by the store-only watchdog).
      if (!turn?.terminal || mirroredTurns.has(turn.id)) return;
      mirroredTurns.add(turn.id);
      try { res.write(idleFrame()); } catch {}
    }, 2000);
    req.on("close", () => clearInterval(idleMirror));

    try {
      const upstream = await ocFetch(await ocBase(), "/event", { signal: controller.signal });
      if (!upstream.ok || !upstream.body) {
        res.write(
          `event: session.error\ndata: ${JSON.stringify({
            error: { message: `opencode /event unavailable (${upstream.status})` },
          })}\n\n`
        );
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });

        // Consume only complete \n\n-delimited records.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          // Collect the data: line(s) within this block.
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (!data) continue;

          let ev;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }

          // Relay only - the global pump owns persistence.
          const out = translateOpencodeEvent(ev, { sessionId: req.params.id, model });
          if (out && out.event) {
            res.write(`event: ${out.event}\ndata: ${JSON.stringify(out.data)}\n\n`);
          }
        }
      }
    } catch (err) {
      // Swallow abort errors; don't surface to a half-open stream.
      if (err?.name !== "AbortError" && !controller.signal.aborted) {
        console.error(`[stream] ${req.params.id}:`, err);
      }
    } finally {
      try { res.end(); } catch {}
    }
  }));

  return app;
}
