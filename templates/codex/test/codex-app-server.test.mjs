import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexAppServer,
  fingerprintForKey,
  threadConfig,
  threadMcpConfig,
} from "../src/codex-app-server.mjs";

test("formats SSH host keys like OpenSSH SHA256 fingerprints", () => {
  assert.match(fingerprintForKey(Buffer.from("host-key")), /^SHA256:[A-Za-z0-9+/]+$/);
});

test("keeps remote Codex sandboxed while using the container permission profile locally", async () => {
  const local = new CodexAppServer({ mode: "chatgpt" });
  const remote = new CodexAppServer({ mode: "remote_ssh" });
  let localTurn;
  let remoteTurn;
  local.request = async (_method, params) => { localTurn = params; };
  remote.request = async (_method, params) => { remoteTurn = params; };

  assert.equal(local.localPermissionProfile, ":danger-full-access");
  assert.deepEqual(local.localArgs().slice(-2), ["-c", 'default_permissions=":danger-full-access"']);
  assert.equal(remote.sandbox, "workspace-write");
  await local.startTurn("local-thread", "hello", "gpt-test");
  await remote.startTurn("remote-thread", "hello", "gpt-test");
  assert.equal(localTurn.permissionProfile, ":danger-full-access");
  assert.equal(remoteTurn.permissionProfile, undefined);
});

test("projects each agent's MCP servers into its own Codex thread config", async () => {
  assert.deepEqual(threadMcpConfig([
    { type: "url", name: "simplefin", url: "https://simplefin.example.test/mcp" },
  ]), {
    mcp_servers: {
      simplefin: { url: "https://simplefin.example.test/mcp" },
    },
  });

  const codex = new CodexAppServer({ mode: "chatgpt" });
  const requests = [];
  codex.request = async (method, params) => {
    requests.push({ method, params });
    return { thread: { id: `thread-${requests.length}` } };
  };
  await codex.startThread({
    cwd: "/workspace/with-mcp",
    model: "gpt-test",
    instructions: "Use SimpleFIN when requested.",
    mcpServers: [{ type: "url", name: "simplefin", url: "https://simplefin.example.test/mcp" }],
  });
  await codex.startThread({ cwd: "/workspace/without-mcp", model: "gpt-test", instructions: "" });

  assert.deepEqual(requests[0].params.config, {
    mcp_servers: {
      simplefin: { url: "https://simplefin.example.test/mcp" },
    },
    "features.apps": false,
  });
  assert.equal(requests[1].params.config, undefined);
});

test("authenticates only the trusted platform MCP with the gateway credential environment", () => {
  const env = {
    LAP_GATEWAY_MCP_BASE_URL: "https://agents.example.test",
    LAP_GATEWAY_API_KEY: "secret-never-copied-into-config",
  };
  assert.deepEqual(threadMcpConfig([
    {
      type: "url",
      name: "platform",
      url: "https://agents.example.test/mcp/platform/agent_1?session_id=ses_1",
    },
  ], env), {
    mcp_servers: {
      platform: {
        url: "https://agents.example.test/mcp/platform/agent_1?session_id=ses_1",
        bearer_token_env_var: "LAP_GATEWAY_API_KEY",
        tool_timeout_sec: 1860,
      },
    },
  });
});

test("routes a trusted platform MCP over the private control-plane network", () => {
  const env = {
    LAP_GATEWAY_MCP_BASE_URL: "https://agents.example.test/gateway",
    LAP_GATEWAY_MCP_INTERNAL_BASE_URL: "http://lap:4000/internal",
    LAP_GATEWAY_API_KEY: "secret",
  };
  assert.deepEqual(threadMcpConfig([
    {
      type: "url",
      name: "platform",
      url: "https://agents.example.test/gateway/mcp/platform/agent_1?session_id=ses_1",
    },
  ], env), {
    mcp_servers: {
      platform: {
        url: "http://lap:4000/internal/mcp/platform/agent_1?session_id=ses_1",
        bearer_token_env_var: "LAP_GATEWAY_API_KEY",
        tool_timeout_sec: 1860,
      },
    },
  });
});

test("disables native Codex collaboration for LAP platform MCP threads", () => {
  const env = {
    LAP_GATEWAY_MCP_BASE_URL: "https://agents.example.test",
    LAP_GATEWAY_MCP_INTERNAL_BASE_URL: "http://lap:4000",
    LAP_GATEWAY_API_KEY: "secret",
  };
  assert.deepEqual(threadConfig([
    {
      type: "url",
      name: "platform",
      url: "https://agents.example.test/mcp/platform/agent_1?session_id=ses_1",
    },
  ], env), {
    mcp_servers: {
      platform: {
        url: "http://lap:4000/mcp/platform/agent_1?session_id=ses_1",
        bearer_token_env_var: "LAP_GATEWAY_API_KEY",
        tool_timeout_sec: 1860,
      },
    },
    "features.apps": false,
    "agents.enabled": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
  });
  assert.deepEqual(threadConfig([
    { type: "url", name: "simplefin", url: "https://simplefin.example.test/mcp" },
  ], env), {
    mcp_servers: {
      simplefin: { url: "https://simplefin.example.test/mcp" },
    },
    "features.apps": false,
  });
});

test("refuses to expose the gateway credential to an untrusted platform MCP", () => {
  const env = {
    LAP_GATEWAY_MCP_BASE_URL: "https://agents.example.test",
    LAP_GATEWAY_API_KEY: "secret",
  };
  assert.throws(
    () => threadMcpConfig([
      { type: "url", name: "platform", url: "https://attacker.example/mcp/platform/agent_1" },
    ], env),
    /untrusted platform MCP URL/,
  );
  assert.throws(
    () => threadMcpConfig([
      { type: "url", name: "platform", url: "https://agents.example.test/not-platform" },
    ], env),
    /untrusted platform MCP URL/,
  );
});

test("rejects invalid MCP definitions before starting a Codex thread", () => {
  assert.throws(
    () => threadMcpConfig([{ type: "url", name: "simplefin", url: "simplefin" }]),
    /absolute HTTP\(S\) URL/,
  );
  assert.throws(
    () => threadMcpConfig([
      { type: "url", name: "duplicate", url: "https://one.example.test/mcp" },
      { type: "url", name: "duplicate", url: "https://two.example.test/mcp" },
    ]),
    /Duplicate Codex MCP server name/,
  );
});

test("interrupts a command that never emits item/completed", async () => {
  const codex = new CodexAppServer({ mode: "chatgpt", commandTimeoutMs: 10 });
  const interruptions = [];
  codex.interrupt = async (threadId, turnId) => interruptions.push({ threadId, turnId });
  let terminal;
  codex.on("notification", (method, params) => {
    if (method === "error") terminal = params;
  });

  codex.onLine(JSON.stringify({
    method: "item/started",
    params: {
      threadId: "thread-stalled",
      turnId: "turn-stalled",
      item: { id: "command-stalled", type: "commandExecution" },
    },
  }));

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(terminal.message, /timed out after 1 seconds/);
  assert.deepEqual(interruptions, [{ threadId: "thread-stalled", turnId: "turn-stalled" }]);
  assert.equal(codex.activeCommands.size, 0);
});

test("clears the command watchdog after item/completed", async () => {
  const codex = new CodexAppServer({ mode: "chatgpt", commandTimeoutMs: 10 });
  const notifications = [];
  codex.on("notification", (method) => notifications.push(method));

  codex.onLine(JSON.stringify({
    method: "item/started",
    params: {
      threadId: "thread-complete",
      turnId: "turn-complete",
      item: { id: "command-complete", type: "commandExecution" },
    },
  }));
  codex.onLine(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-complete",
      turnId: "turn-complete",
      item: { id: "command-complete", type: "commandExecution" },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(notifications, ["item/started", "item/completed"]);
  assert.equal(codex.activeCommands.size, 0);
});

test("ChatGPT mode uses native account and model RPCs without an API provider", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
  const executable = path.join(root, "codex");
  fs.writeFileSync(executable, `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("model_provider=\\\"runtime_backend\\\"")) process.exit(91);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  let result = {};
  if (message.method === "account/read") result = { account: null, requiresOpenaiAuth: true };
  if (message.method === "account/login/start") result = { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://example.test/device", userCode: "ABCD-1234" };
  if (message.method === "model/list") result = { data: [{ id: "gpt-test", model: "gpt-test" }] };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`, { mode: 0o755 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const codex = new CodexAppServer({
    mode: "chatgpt",
    defaultModel: "gpt-test",
    codexHome: path.join(root, "home"),
    codexBin: executable,
  });
  t.after(() => codex.stop());
  await codex.start();
  assert.equal((await codex.readAccount()).account, null);
  assert.equal((await codex.startDeviceLogin()).userCode, "ABCD-1234");
  assert.equal((await codex.listModels()).data[0].id, "gpt-test");
  assert.equal(codex.healthy(), true);
});
