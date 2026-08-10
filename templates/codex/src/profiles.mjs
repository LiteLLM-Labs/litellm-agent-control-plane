import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createApp } from "./app.mjs";
import { CodexAppServer, normalizeBaseUrl } from "./codex-app-server.mjs";
import { createStore } from "./store.mjs";

const PROFILE_TYPES = new Set(["api", "chatgpt", "remote_ssh"]);
const ALIAS_PATTERN = /^[A-Za-z0-9_-]+$/;

function deriveKey(secret) {
  if (!secret) throw new Error("PROFILE_ENCRYPTION_KEY or RUNTIME_API_KEY is required for Codex profiles");
  return crypto.createHash("sha256").update(`lap-codex-profiles:${secret}`).digest();
}

function encryptJson(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptJson(value, key) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(value.data, "base64")),
    decipher.final(),
  ]).toString("utf8"));
}

function validateProfile(input) {
  const profile = structuredClone(input || {});
  profile.alias = String(profile.alias || "").trim();
  profile.type = String(profile.type || "").trim();
  if (!ALIAS_PATTERN.test(profile.alias)) throw new Error("Profile alias may only contain letters, numbers, hyphens, and underscores");
  if (!PROFILE_TYPES.has(profile.type)) throw new Error("Unknown Codex profile type");

  if (profile.type === "api") {
    profile.baseUrl = String(profile.baseUrl || "").trim();
    profile.apiKey = String(profile.apiKey || "").trim();
    profile.model = String(profile.model || "").trim() || "gpt-5.6-sol-high";
    if (!profile.baseUrl) throw new Error("OpenAI-compatible base URL is required");
    if (!profile.apiKey) throw new Error("OpenAI API key is required");
    const parsed = new URL(profile.baseUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("OpenAI-compatible base URL must use HTTP or HTTPS");
  } else if (profile.type === "chatgpt") {
    profile.model = String(profile.model || "").trim() || "gpt-5.6-sol";
  } else {
    profile.model = String(profile.model || "").trim() || "gpt-5.6-sol";
    profile.ssh = profile.ssh || {};
    profile.ssh.host = String(profile.ssh.host || "").trim();
    profile.ssh.port = Number(profile.ssh.port || 22);
    profile.ssh.username = String(profile.ssh.username || "").trim();
    profile.ssh.password = String(profile.ssh.password || "");
    profile.ssh.privateKey = String(profile.ssh.privateKey || "");
    profile.ssh.passphrase = String(profile.ssh.passphrase || "");
    profile.ssh.workspace = String(profile.ssh.workspace || "").trim() || ".";
    profile.ssh.codexBin = String(profile.ssh.codexBin || "").trim() || "codex";
    profile.ssh.hostFingerprint = String(profile.ssh.hostFingerprint || "").trim();
    if (!profile.ssh.host || !profile.ssh.username) throw new Error("SSH host and username are required");
    if (!Number.isInteger(profile.ssh.port) || profile.ssh.port < 1 || profile.ssh.port > 65535) throw new Error("SSH port must be between 1 and 65535");
    if (!profile.ssh.password && !profile.ssh.privateKey) throw new Error("SSH password or private key is required");
  }
  return profile;
}

function publicProfile(profile, instance) {
  return {
    alias: profile.alias,
    type: profile.type,
    model: profile.model,
    ready: Boolean(instance?.codex?.healthy()),
    error: instance?.error || null,
    ...(profile.type === "api" ? { baseUrl: profile.baseUrl } : {}),
    ...(profile.type === "remote_ssh" ? {
      ssh: {
        host: profile.ssh.host,
        port: profile.ssh.port,
        username: profile.ssh.username,
        workspace: profile.ssh.workspace,
        codexBin: profile.ssh.codexBin,
        hostFingerprint: profile.ssh.hostFingerprint || instance?.codex?.hostFingerprint || null,
        authMethod: profile.ssh.privateKey ? "private_key" : "password",
      },
    } : {}),
  };
}

export class CodexProfileManager {
  constructor({ dataRoot, runtimeApiKey, encryptionSecret, codexFactory = (options) => new CodexAppServer(options) }) {
    this.dataRoot = dataRoot;
    this.runtimeApiKey = runtimeApiKey;
    this.file = path.join(dataRoot, "profiles.enc.json");
    this.key = deriveKey(encryptionSecret || runtimeApiKey);
    this.codexFactory = codexFactory;
    this.profiles = new Map();
    this.instances = new Map();
    fs.mkdirSync(dataRoot, { recursive: true });
  }

  async init() {
    if (fs.existsSync(this.file)) {
      const payload = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const encrypted of payload.profiles || []) {
        const profile = validateProfile(decryptJson(encrypted, this.key));
        this.profiles.set(profile.alias, profile);
      }
    }
    for (const profile of this.profiles.values()) {
      try {
        await this.startProfile(profile);
      } catch (error) {
        console.error(`[profile:${profile.alias}] startup failed: ${error.message}`);
        this.instances.set(profile.alias, { error: error.message });
      }
    }
  }

  save() {
    const temporary = `${this.file}.tmp`;
    const payload = {
      version: 1,
      profiles: [...this.profiles.values()].map((profile) => encryptJson(profile, this.key)),
    };
    fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  async startProfile(profile) {
    const root = path.join(this.dataRoot, profile.alias);
    const codexHome = path.join(root, "codex-home");
    const workspaceRoot = path.join(root, "workspace");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const codex = this.codexFactory({
      mode: profile.type,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      defaultModel: profile.model,
      codexHome,
      ssh: profile.ssh,
    });
    await codex.start();
    const store = createStore(path.join(root, "agents.db"));
    const listModels = profile.type === "api"
      ? () => discoverApiModels(profile)
      : async () => {
        const result = await codex.listModels();
        return {
          object: "list",
          data: (result?.data || []).map((entry) => ({
            id: entry.model || entry.id,
            object: "model",
            owned_by: profile.type === "chatgpt" ? "chatgpt" : "remote_codex",
          })),
        };
      };
    const app = createApp({
      store,
      codex,
      workspaceRoot,
      defaultModel: profile.model,
      listModels,
      runtimeApiKey: this.runtimeApiKey,
      ...(profile.type === "remote_ssh" ? { createWorkspace: async () => profile.ssh.workspace } : {}),
    });
    this.instances.set(profile.alias, { codex, store, app, error: null });
    return this.instances.get(profile.alias);
  }

  async create(input) {
    const profile = validateProfile(input);
    if (this.profiles.has(profile.alias)) throw new Error(`Codex profile already exists: ${profile.alias}`);
    const instance = await this.startProfile(profile);
    if (profile.type === "remote_ssh" && !profile.ssh.hostFingerprint && instance.codex.hostFingerprint) {
      profile.ssh.hostFingerprint = instance.codex.hostFingerprint;
    }
    this.profiles.set(profile.alias, profile);
    try {
      this.save();
    } catch (error) {
      this.stopInstance(profile.alias);
      this.profiles.delete(profile.alias);
      throw error;
    }
    return publicProfile(profile, this.instances.get(profile.alias));
  }

  list() {
    return [...this.profiles.values()].map((profile) => publicProfile(profile, this.instances.get(profile.alias)));
  }

  get(alias) {
    const profile = this.profiles.get(alias);
    return profile ? publicProfile(profile, this.instances.get(alias)) : null;
  }

  handler(alias) {
    return this.instances.get(alias)?.app || null;
  }

  codex(alias) {
    return this.instances.get(alias)?.codex || null;
  }

  async delete(alias) {
    if (!this.profiles.has(alias)) return false;
    this.stopInstance(alias);
    this.profiles.delete(alias);
    this.save();
    const root = path.resolve(this.dataRoot, alias);
    const expectedParent = `${path.resolve(this.dataRoot)}${path.sep}`;
    if (root.startsWith(expectedParent)) fs.rmSync(root, { recursive: true, force: true });
    return true;
  }

  stopInstance(alias) {
    const instance = this.instances.get(alias);
    instance?.codex?.stop();
    instance?.store?.close();
    this.instances.delete(alias);
  }

  stop() {
    for (const alias of [...this.instances.keys()]) this.stopInstance(alias);
  }
}

async function discoverApiModels(profile) {
  try {
    const response = await fetch(`${normalizeBaseUrl(profile.baseUrl)}/models`, {
      headers: { authorization: `Bearer ${profile.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`model discovery returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.data)) throw new Error("model discovery returned an invalid response");
    return payload;
  } catch (error) {
    console.warn(`[profile:${profile.alias}:models] ${error.message}; using configured model`);
    return { object: "list", data: [{ id: profile.model, object: "model", owned_by: "runtime_backend" }] };
  }
}

export const profileInternals = { decryptJson, deriveKey, encryptJson, publicProfile, validateProfile };
