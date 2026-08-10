import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import express from "express";

import {
  agentResponse,
  modelId,
  sessionResponse,
  textFromEvents,
  translateNotification,
} from "./protocol.mjs";

const randomId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;

export function createApp({ store, codex, workspaceRoot, defaultModel, listModels, runtimeApiKey, createWorkspace }) {
  const app = express();
  const liveEvents = new EventEmitter();
  const environments = new Map();
  const messageItems = new Map();
  let eventCounter = 0;

  app.use(express.json({ limit: "5mb" }));
  app.use("/v1", (req, res, next) => {
    if (!runtimeApiKey || req.get("x-api-key") === runtimeApiKey) return next();
    return res.status(401).json({ error: "invalid runtime API key" });
  });

  const wrap = (handler) => (req, res) => Promise.resolve(handler(req, res)).catch((error) => {
    console.error(`[http] ${req.method} ${req.path}:`, error?.message || error);
    if (!res.headersSent) res.status(500).json({ error: error?.message || String(error) });
  });

  function emit(sessionId, event) {
    const eventId = `evt_${++eventCounter}_${crypto.randomBytes(4).toString("hex")}`;
    store.insertEvent(sessionId, eventId, event);
    liveEvents.emit(sessionId, runtimeEventForClient({ event_id: eventId, ...event }));
  }

  codex.on("notification", (method, params) => {
    const threadId = params?.threadId || params?.thread?.id;
    if (!threadId) return;
    const session = store.getSessionByThread(threadId);
    if (!session) return;
    if (method === "item/agentMessage/delta" && params.itemId) {
      if (!messageItems.has(session.id)) messageItems.set(session.id, new Set());
      messageItems.get(session.id).add(params.itemId);
    }
    const events = translateNotification(method, params, {
      model: store.getAgent(session.agent_id)?.model,
      messageItems: messageItems.get(session.id),
    });
    for (const event of events) emit(session.id, event);
    if (events.some((event) => event.event === "session.status_running")) {
      store.updateSession(session.id, { status: "running" });
    }
    if (events.some((event) => event.event === "session.status_idle" || event.event === "session.error")) {
      store.updateSession(session.id, { status: "idle", active_turn_id: null });
    }
  });

  app.get("/health", (_req, res) => res.status(codex.healthy() ? 200 : 503).json({
    ok: codex.healthy(),
    codex_app_server: codex.healthy(),
  }));

  app.get("/v1/models", wrap(async (_req, res) => res.json(await listModels())));

  app.post("/v1/agents", wrap(async (req, res) => {
    const row = store.createAgent({
      name: req.body?.name,
      system: req.body?.system,
      model: modelId(req.body?.model) || defaultModel,
      permissions: req.body?.permissions,
      mcp_servers: req.body?.mcp_servers,
    });
    res.json(agentResponse(row));
  }));

  app.get("/v1/agents", (_req, res) => res.json({ data: store.listAgents().map(agentResponse) }));

  app.get("/v1/agents/:id", (req, res) => {
    const row = store.getAgent(req.params.id);
    if (!row) return res.status(404).json({ error: "agent not found" });
    return res.json(agentResponse(row));
  });

  app.patch("/v1/agents/:id", (req, res) => {
    const patch = {};
    for (const key of ["name", "system", "permissions", "mcp_servers"]) {
      if (req.body?.[key] !== undefined) patch[key] = req.body[key];
    }
    if (req.body?.model !== undefined) patch.model = modelId(req.body.model);
    const row = store.updateAgent(req.params.id, patch);
    if (!row) return res.status(404).json({ error: "agent not found" });
    return res.json(agentResponse(row));
  });

  app.delete("/v1/agents/:id", (req, res) => {
    if (!store.deleteAgent(req.params.id)) return res.status(404).json({ error: "agent not found" });
    return res.status(204).end();
  });

  app.post("/v1/environments", (req, res) => {
    const environment = {
      id: randomId("env"), type: "environment", name: req.body?.name || null,
      config: req.body?.config || {},
    };
    environments.set(environment.id, environment);
    res.json(environment);
  });

  app.post("/v1/sessions", wrap(async (req, res) => {
    const agent = store.getAgent(req.body?.agent);
    if (!agent) return res.status(400).json({ error: "unknown agent" });
    const workspace = createWorkspace
      ? await createWorkspace(randomId("workspace"))
      : path.join(workspaceRoot, randomId("workspace"));
    if (!createWorkspace) mkdirSync(workspace, { recursive: true });
    const result = await codex.startThread({
      cwd: workspace,
      model: agent.model,
      instructions: agent.system,
      mcpServers: agent.mcp_servers,
    });
    const threadId = result?.thread?.id;
    if (!threadId) throw new Error("Codex thread/start response did not include a thread id");
    const row = store.createSession({
      agent_id: agent.id,
      thread_id: threadId,
      environment_id: req.body?.environment_id,
      workspace,
    });
    res.json(sessionResponse(row));
  }));

  app.post("/v1/sessions/:id/events", wrap(async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "session not found" });
    if (session.active_turn_id) return res.status(409).json({ error: "session already has an active turn" });
    const text = textFromEvents(req.body?.events);
    if (!text) return res.status(400).json({ error: "no user.message text" });
    const agent = store.getAgent(session.agent_id);
    emit(session.id, { event: "user.message", data: { content: [{ type: "text", text }] } });
    await codex.ensureThread(session.thread_id);
    const result = await codex.startTurn(session.thread_id, text, agent?.model || defaultModel);
    const turnId = result?.turn?.id;
    if (!turnId) throw new Error("Codex turn/start response did not include a turn id");
    store.updateSession(session.id, { status: "running", active_turn_id: turnId });
    res.status(202).json({ ok: true, turn_id: turnId });
  }));

  app.post("/v1/sessions/:id/abort", wrap(async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "session not found" });
    if (!session.active_turn_id) return res.json({ aborted: false });
    await codex.interrupt(session.thread_id, session.active_turn_id);
    store.updateSession(session.id, { status: "idle", active_turn_id: null });
    res.json({ aborted: true });
  }));

  app.get("/v1/sessions/:id/events", (req, res) => {
    const data = store.listEvents(req.params.id).map((stored) => {
      const event = runtimeEventForClient(stored);
      return { type: event.event, ...event.data };
    });
    res.json({ data });
  });

  app.get("/v1/sessions/:id/events/stream", (req, res) => {
    if (!store.getSession(req.params.id)) return res.status(404).json({ error: "session not found" });
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();
    const write = (event) => res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data || {})}\n\n`);
    for (const stored of store.listEvents(req.params.id)) write(runtimeEventForClient(stored));
    liveEvents.on(req.params.id, write);
    req.on("close", () => liveEvents.off(req.params.id, write));
  });

  return app;
}

export function runtimeEventForClient(stored) {
  const data = stored?.data && typeof stored.data === "object" ? stored.data : {};
  const itemId = typeof data.item_id === "string" && data.item_id
    ? data.item_id
    : typeof data.id === "string" && data.id
      ? data.id
      : null;
  return {
    event: stored.event,
    data: {
      ...data,
      ...(itemId ? { item_id: itemId } : {}),
      id: stored.event_id,
    },
  };
}
