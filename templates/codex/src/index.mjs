import { mkdirSync } from "node:fs";

import express from "express";

import { createApp } from "./app.mjs";
import { CodexAppServer, normalizeBaseUrl } from "./codex-app-server.mjs";
import { CodexProfileManager } from "./profiles.mjs";
import { createStore } from "./store.mjs";

const port = Number(process.env.PORT || 8080);
const dbPath = process.env.DB_PATH || "/data/agents.db";
const dataRoot = process.env.PROFILE_DATA_ROOT || "/data/codex-profiles";
const workspaceRoot = process.env.WORKSPACE_ROOT || "/workspace";
const codexHome = process.env.CODEX_HOME || "/codex-home";
const baseUrl = process.env.MODEL_BASE_URL || process.env.LITELLM_BASE_URL || "https://api.openai.com/v1";
const apiKey = process.env.MODEL_API_KEY || process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY || "";
const defaultModel = process.env.DEFAULT_MODEL || process.env.LITELLM_DEFAULT_MODEL || "gpt-5.6-sol-high";
const runtimeApiKey = process.env.RUNTIME_API_KEY || "";
const configuredModels = (process.env.MODEL_MODELS || process.env.LITELLM_MODELS || defaultModel)
  .split(",").map((value) => value.trim()).filter(Boolean);

if (!runtimeApiKey) throw new Error("RUNTIME_API_KEY is required");
mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(codexHome, { recursive: true });

const profileManager = new CodexProfileManager({
  dataRoot,
  runtimeApiKey,
  encryptionSecret: process.env.PROFILE_ENCRYPTION_KEY || runtimeApiKey,
});
await profileManager.init();

let legacy = null;
if (apiKey) {
  const store = createStore(dbPath);
  const codex = new CodexAppServer({ mode: "api", baseUrl, apiKey, defaultModel, codexHome });
  await codex.start();
  legacy = {
    store,
    codex,
    app: createApp({
      store,
      codex,
      workspaceRoot,
      defaultModel,
      listModels: discoverLegacyModels,
      runtimeApiKey,
    }),
  };
}

const app = express();
const control = express.Router();
control.use(express.json({ limit: "2mb" }));
control.use((req, res, next) => {
  const bearer = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (req.get("x-api-key") === runtimeApiKey || bearer === runtimeApiKey) return next();
  return res.status(401).json({ error: "invalid runtime API key" });
});

const wrap = (handler) => (req, res) => Promise.resolve(handler(req, res)).catch((error) => {
  console.error(`[control] ${req.method} ${req.path}: ${error.message}`);
  if (!res.headersSent) res.status(400).json({ error: error.message });
});

control.get("/health", (_req, res) => res.json({ ok: true, profiles: profileManager.list().length }));
control.get("/profiles", (_req, res) => res.json({ profiles: profileManager.list() }));
control.post("/profiles", wrap(async (req, res) => {
  const profile = await profileManager.create(req.body);
  res.status(201).json({ profile });
}));
control.get("/profiles/:alias", (req, res) => {
  const profile = profileManager.get(req.params.alias);
  if (!profile) return res.status(404).json({ error: "Codex profile not found" });
  return res.json({ profile });
});
control.delete("/profiles/:alias", wrap(async (req, res) => {
  if (!await profileManager.delete(req.params.alias)) return res.status(404).json({ error: "Codex profile not found" });
  return res.json({ ok: true });
}));
control.get("/profiles/:alias/account", wrap(async (req, res) => {
  const codex = requireProfileCodex(profileManager, req.params.alias);
  res.json(await codex.readAccount(req.query.refresh === "true"));
}));
control.post("/profiles/:alias/login/start", wrap(async (req, res) => {
  const profile = profileManager.get(req.params.alias);
  if (!profile) return res.status(404).json({ error: "Codex profile not found" });
  if (profile.type !== "chatgpt") return res.status(400).json({ error: "Login is only available for ChatGPT profiles" });
  res.json(await requireProfileCodex(profileManager, req.params.alias).startDeviceLogin());
}));
control.post("/profiles/:alias/login/cancel", wrap(async (req, res) => {
  if (!req.body?.loginId) return res.status(400).json({ error: "loginId is required" });
  res.json(await requireProfileCodex(profileManager, req.params.alias).cancelLogin(req.body.loginId));
}));
control.post("/profiles/:alias/logout", wrap(async (req, res) => {
  res.json(await requireProfileCodex(profileManager, req.params.alias).logout());
}));

app.use("/control", control);
app.use("/profiles/:alias", (req, res, next) => {
  const handler = profileManager.handler(req.params.alias);
  if (!handler) return res.status(404).json({ error: "Codex profile not found or unavailable" });
  return handler(req, res, next);
});
app.get("/health", (_req, res) => {
  const profiles = profileManager.list();
  const rootReady = legacy?.codex.healthy() || false;
  const ok = rootReady || profiles.some((profile) => profile.ready);
  res.status(ok ? 200 : 503).json({
    ok,
    codex_app_server: rootReady,
    profiles: profiles.map(({ alias, type, ready, error }) => ({ alias, type, ready, error })),
  });
});
if (legacy) app.use(legacy.app);

const server = app.listen(port, "0.0.0.0", () => console.log(`[boot] Codex runtime listening on :${port}`));

async function discoverLegacyModels() {
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`model discovery returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.data)) throw new Error("model discovery returned an invalid response");
    return payload;
  } catch (error) {
    console.warn(`[models] ${error.message}; using configured fallback`);
    return { object: "list", data: configuredModels.map((id) => ({ id, object: "model", owned_by: "runtime_backend" })) };
  }
}

function requireProfileCodex(manager, alias) {
  const codex = manager.codex(alias);
  if (!codex) throw new Error(`Codex profile is unavailable: ${alias}`);
  return codex;
}

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[shutdown] ${signal}`);
  server.close(() => {
    legacy?.codex.stop();
    legacy?.store.close();
    profileManager.stop();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
