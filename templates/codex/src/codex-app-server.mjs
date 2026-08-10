import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import readline from "node:readline";
import { Client as SshClient } from "ssh2";

function toml(value) {
  return JSON.stringify(String(value));
}

function platformMcpCredential(parsed, env) {
  const trustedValue = String(env.LAP_GATEWAY_MCP_BASE_URL || "").trim();
  const credentialValue = String(env.LAP_GATEWAY_API_KEY || "").trim();
  if (!trustedValue || !credentialValue) {
    throw new Error(
      "Codex platform MCP requires LAP_GATEWAY_MCP_BASE_URL and LAP_GATEWAY_API_KEY",
    );
  }
  let trusted;
  try {
    trusted = new URL(trustedValue);
  } catch {
    throw new Error("LAP_GATEWAY_MCP_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (!(["http:", "https:"].includes(trusted.protocol)) || !trusted.hostname || trusted.username || trusted.password) {
    throw new Error("LAP_GATEWAY_MCP_BASE_URL must be an absolute HTTP(S) URL");
  }
  const basePath = trusted.pathname.replace(/\/+$/, "");
  const platformPath = `${basePath}/mcp/platform/`.replace(/^\/\//, "/");
  if (parsed.origin !== trusted.origin || !parsed.pathname.startsWith(platformPath)) {
    throw new Error("Refusing to send the gateway credential to an untrusted platform MCP URL");
  }
  const internalValue = String(env.LAP_GATEWAY_MCP_INTERNAL_BASE_URL || "").trim();
  if (!internalValue) return { bearer_token_env_var: "LAP_GATEWAY_API_KEY" };
  let internal;
  try {
    internal = new URL(internalValue);
  } catch {
    throw new Error("LAP_GATEWAY_MCP_INTERNAL_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (!(["http:", "https:"].includes(internal.protocol)) || !internal.hostname || internal.username || internal.password) {
    throw new Error("LAP_GATEWAY_MCP_INTERNAL_BASE_URL must be an absolute HTTP(S) URL");
  }
  const relativePath = parsed.pathname.slice(basePath.length);
  const internalPath = internal.pathname.replace(/\/+$/, "");
  internal.pathname = `${internalPath}${relativePath}`;
  internal.search = parsed.search;
  internal.hash = "";
  return {
    url: internal.toString(),
    bearer_token_env_var: "LAP_GATEWAY_API_KEY",
  };
}

export function threadMcpConfig(servers = [], env = process.env) {
  if (!Array.isArray(servers)) throw new Error("mcp_servers must be an array");
  const configured = {};
  for (const server of servers) {
    if (!server || typeof server !== "object" || Array.isArray(server)) {
      throw new Error("mcp_servers entries must be objects");
    }
    const type = String(server.type || "url").trim();
    if (type !== "url") throw new Error(`Unsupported Codex MCP server type: ${type}`);
    const name = String(server.name || "").trim();
    if (!name) throw new Error("Codex MCP servers require a name");
    if (Object.hasOwn(configured, name)) throw new Error(`Duplicate Codex MCP server name: ${name}`);
    const url = String(server.url || "").trim();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Codex MCP server ${name} requires an absolute HTTP(S) URL`);
    }
    if (!(["http:", "https:"].includes(parsed.protocol)) || !parsed.hostname) {
      throw new Error(`Codex MCP server ${name} requires an absolute HTTP(S) URL`);
    }
    configured[name] = {
      url,
      ...(name === "platform" ? {
        ...platformMcpCredential(parsed, env),
        // LAP sub-agents can perform long, multi-tool jobs. Keep the Codex
        // client alive slightly longer than LAP's 30-minute server timeout so
        // LAP, rather than the transport, owns the terminal result.
        tool_timeout_sec: 31 * 60,
      } : {}),
    };
  }
  return Object.keys(configured).length > 0 ? { mcp_servers: configured } : null;
}

export function threadConfig(servers = [], env = process.env) {
  const mcpConfig = threadMcpConfig(servers, env);
  const managedMcpConfig = mcpConfig ? {
    ...mcpConfig,
    "features.apps": false,
  } : null;
  const hasPlatformMcp = servers.some((server) => (
    server && typeof server === "object" && !Array.isArray(server)
      && String(server.name || "").trim() === "platform"
  ));
  if (!hasPlatformMcp) return managedMcpConfig;
  return {
    ...(managedMcpConfig || {}),
    "agents.enabled": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
  };
}

export function normalizeBaseUrl(value) {
  const base = value.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export class CodexAppServer extends EventEmitter {
  constructor({
    mode = "api",
    baseUrl,
    apiKey,
    defaultModel,
    codexHome,
    codexBin = "codex",
    ssh = null,
    sandbox = null,
    commandTimeoutMs = configuredCommandTimeoutMs(process.env),
  }) {
    super();
    this.mode = mode;
    this.baseUrl = baseUrl ? normalizeBaseUrl(baseUrl) : null;
    this.apiKey = apiKey || "";
    this.defaultModel = defaultModel;
    this.codexHome = codexHome;
    this.codexBin = codexBin;
    this.ssh = ssh;
    this.sandbox = sandbox || (mode === "remote_ssh"
      ? "workspace-write"
      : process.env.CODEX_LOCAL_SANDBOX || "workspace-write");
    this.localPermissionProfile = process.env.CODEX_LOCAL_PERMISSION_PROFILE || ":danger-full-access";
    this.pending = new Map();
    this.threads = new Set();
    this.commandTimeoutMs = commandTimeoutMs;
    this.activeCommands = new Map();
    this.nextId = 1;
    this.child = null;
    this.sshClient = null;
    this.input = null;
    this.hostFingerprint = null;
  }

  async start() {
    if (this.input) return;
    if (this.mode === "remote_ssh") await this.startRemote();
    else this.startLocal();
    await this.request("initialize", {
      clientInfo: { name: "litellm-agent-control-plane", title: "LAP Codex Runtime", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  localArgs() {
    const args = ["app-server", "--listen", "stdio://"];
    args.push("-c", `default_permissions=${toml(this.localPermissionProfile)}`);
    if (this.mode !== "api") return args;
    return args.concat([
      "-c", `model=${toml(this.defaultModel)}`,
      "-c", 'model_provider="runtime_backend"',
      "-c", 'model_providers.runtime_backend.name="Runtime Backend"',
      "-c", `model_providers.runtime_backend.base_url=${toml(this.baseUrl)}`,
      "-c", 'model_providers.runtime_backend.env_key="RUNTIME_MODEL_API_KEY"',
      "-c", 'model_providers.runtime_backend.wire_api="responses"',
    ]);
  }

  startLocal() {
    this.child = spawn(this.codexBin, this.localArgs(), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: this.codexHome, RUNTIME_MODEL_API_KEY: this.apiKey },
    });
    this.input = this.child.stdin;
    this.child.once("exit", (code, signal) => this.failAll(new Error(`codex app-server exited (${code ?? signal})`)));
    this.child.stderr.on("data", (chunk) => process.stderr.write(`[codex:${this.mode}] ${chunk}`));
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
  }

  async startRemote() {
    const ssh = this.ssh || {};
    if (!ssh.host || !ssh.username) throw new Error("SSH host and username are required");
    if (!/^[A-Za-z0-9_./-]+$/.test(ssh.codexBin || "codex")) throw new Error("Invalid remote Codex executable");
    const workspace = ssh.workspace || ".";
    const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
    const command = `mkdir -p -- ${quote(workspace)} && cd -- ${quote(workspace)} && exec ${ssh.codexBin || "codex"} app-server --listen stdio://`;
    const client = new SshClient();
    this.sshClient = client;
    const expected = normalizeFingerprint(ssh.hostFingerprint);
    await new Promise((resolve, reject) => {
      const fail = (error) => reject(new Error(`SSH connection failed: ${error.message}`));
      client.once("ready", resolve);
      client.once("error", fail);
      client.connect({
        host: ssh.host,
        port: Number(ssh.port || 22),
        username: ssh.username,
        ...(ssh.password ? { password: ssh.password } : {}),
        ...(ssh.privateKey ? { privateKey: ssh.privateKey } : {}),
        ...(ssh.passphrase ? { passphrase: ssh.passphrase } : {}),
        readyTimeout: 15_000,
        hostVerifier: (key) => {
          this.hostFingerprint = fingerprintForKey(key);
          return !expected || expected === normalizeFingerprint(this.hostFingerprint);
        },
      });
    });
    const stream = await new Promise((resolve, reject) => {
      client.exec(command, (error, channel) => error ? reject(error) : resolve(channel));
    });
    this.child = stream;
    this.input = stream;
    stream.once("close", (code, signal) => this.failAll(new Error(`remote codex app-server exited (${code ?? signal})`)));
    stream.stderr.on("data", (chunk) => process.stderr.write(`[codex:remote] ${chunk}`));
    readline.createInterface({ input: stream }).on("line", (line) => this.onLine(line));
  }

  send(message) {
    if (!this.input?.writable) throw new Error("codex app-server is not running");
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex JSON-RPC error"));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      this.answerServerRequest(message);
      return;
    }
    if (message.method) {
      const params = message.params || {};
      this.observeNotification(message.method, params);
      this.emit("notification", message.method, params);
    }
  }

  observeNotification(method, params) {
    const item = params?.item;
    if (method === "item/started" && item?.type === "commandExecution") {
      this.trackCommand(params.threadId, params.turnId, item.id);
      return;
    }
    if (method === "item/completed" && item?.id) {
      this.clearCommand(item.id);
      return;
    }
    if (method === "turn/completed" || (method === "error" && !params?.willRetry)) {
      this.clearCommandsForTurn(params?.threadId, params?.turn?.id || params?.turnId);
    }
  }

  trackCommand(threadId, turnId, itemId) {
    if (!threadId || !itemId || this.commandTimeoutMs <= 0) return;
    this.clearCommand(itemId);
    const timer = setTimeout(() => {
      const active = this.activeCommands.get(itemId);
      if (!active) return;
      this.activeCommands.delete(itemId);
      const seconds = Math.ceil(this.commandTimeoutMs / 1000);
      const message = `Codex command execution timed out after ${seconds} seconds`;
      this.emit("notification", "error", {
        threadId: active.threadId,
        turnId: active.turnId,
        willRetry: false,
        message,
      });
      if (active.turnId) {
        this.interrupt(active.threadId, active.turnId).catch((error) => {
          process.stderr.write(`[codex:${this.mode}] failed to interrupt timed-out command: ${error.message}\n`);
        });
      }
    }, this.commandTimeoutMs);
    timer.unref?.();
    this.activeCommands.set(itemId, { threadId, turnId, timer });
  }

  clearCommand(itemId) {
    const active = this.activeCommands.get(itemId);
    if (!active) return;
    clearTimeout(active.timer);
    this.activeCommands.delete(itemId);
  }

  clearCommandsForTurn(threadId, turnId) {
    for (const [itemId, active] of this.activeCommands) {
      if (threadId && active.threadId !== threadId) continue;
      if (turnId && active.turnId && active.turnId !== turnId) continue;
      this.clearCommand(itemId);
    }
  }

  clearCommandTimers() {
    for (const itemId of [...this.activeCommands.keys()]) this.clearCommand(itemId);
  }

  answerServerRequest(message) {
    let result = {};
    if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
      result = { decision: "decline" };
    } else if (message.method === "item/tool/requestUserInput") {
      result = { answers: {} };
    } else if (message.method === "item/permissions/requestApproval") {
      result = { permissions: {} };
    }
    this.send({ jsonrpc: "2.0", id: message.id, result });
  }

  async startThread({ cwd, model, instructions, mcpServers = [] }) {
    const config = threadConfig(mcpServers);
    const params = {
      cwd,
      model,
      approvalPolicy: "never",
      ...(this.mode === "remote_ssh" ? { sandbox: this.sandbox } : {}),
      developerInstructions: instructions || null,
      ephemeral: false,
      ...(config ? { config } : {}),
      ...(this.mode === "api" ? { modelProvider: "runtime_backend" } : {}),
    };
    const result = await this.request("thread/start", params);
    if (result?.thread?.id) this.threads.add(result.thread.id);
    return result;
  }

  async ensureThread(threadId) {
    if (this.threads.has(threadId)) return;
    await this.request("thread/resume", { threadId });
    this.threads.add(threadId);
  }

  startTurn(threadId, text, model) {
    return this.request("turn/start", {
      threadId,
      model,
      approvalPolicy: "never",
      ...(this.mode === "remote_ssh" ? {} : { permissionProfile: this.localPermissionProfile }),
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  interrupt(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  listModels() {
    return this.request("model/list", { limit: 100, includeHidden: false });
  }

  readAccount(refreshToken = false) {
    return this.request("account/read", { refreshToken });
  }

  startDeviceLogin() {
    return this.request("account/login/start", { type: "chatgptDeviceCode" });
  }

  cancelLogin(loginId) {
    return this.request("account/login/cancel", { loginId });
  }

  logout() {
    return this.request("account/logout");
  }

  failAll(error) {
    const child = this.child;
    this.child = null;
    this.input = null;
    this.threads.clear();
    this.clearCommandTimers();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    if (child) this.emit("exit", error);
  }

  healthy() {
    if (!this.input?.writable) return false;
    if (this.mode === "remote_ssh") return Boolean(this.sshClient);
    return Boolean(this.child && !this.child.killed && this.child.exitCode == null);
  }

  stop() {
    this.clearCommandTimers();
    if (this.child?.kill) this.child.kill("SIGTERM");
    else this.child?.close?.();
    this.sshClient?.end();
    this.sshClient = null;
    this.child = null;
    this.input = null;
  }
}

function configuredCommandTimeoutMs(env) {
  const seconds = Number(env.CODEX_COMMAND_TIMEOUT_SEC || 600);
  if (!Number.isFinite(seconds) || seconds < 0) return 600_000;
  return Math.floor(seconds * 1000);
}

function normalizeFingerprint(value) {
  if (!value) return "";
  return String(value).trim().replace(/^SHA256:/i, "").replace(/=+$/, "");
}

export function fingerprintForKey(key) {
  return `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}
