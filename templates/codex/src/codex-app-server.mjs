import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import readline from "node:readline";
import { Client as SshClient } from "ssh2";

function toml(value) {
  return JSON.stringify(String(value));
}

export function normalizeBaseUrl(value) {
  const base = value.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export class CodexAppServer extends EventEmitter {
  constructor({ mode = "api", baseUrl, apiKey, defaultModel, codexHome, codexBin = "codex", ssh = null, sandbox = null }) {
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
    if (message.method) this.emit("notification", message.method, message.params || {});
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

  async startThread({ cwd, model, instructions }) {
    const params = {
      cwd,
      model,
      approvalPolicy: "never",
      ...(this.mode === "remote_ssh" ? { sandbox: this.sandbox } : {}),
      developerInstructions: instructions || null,
      ephemeral: false,
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
    if (this.child?.kill) this.child.kill("SIGTERM");
    else this.child?.close?.();
    this.sshClient?.end();
    this.sshClient = null;
    this.child = null;
    this.input = null;
  }
}

function normalizeFingerprint(value) {
  if (!value) return "";
  return String(value).trim().replace(/^SHA256:/i, "").replace(/=+$/, "");
}

export function fingerprintForKey(key) {
  return `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}
