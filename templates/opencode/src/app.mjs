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
      return res
        .status(502)
        .json({ error: `opencode prompt failed (${r.status})`, detail: detail.slice(0, 500) });
    }

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

  // Historical events (stub).
  app.get("/v1/sessions/:id/events", wrap(async (_req, res) => {
    res.json({ data: [] });
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
