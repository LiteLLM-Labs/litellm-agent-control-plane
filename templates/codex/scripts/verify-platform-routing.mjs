import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAppServer } from "../src/codex-app-server.mjs";

const requests = [];
const waiters = [];
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (request.url === "/mcp") {
    if (body.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    const result = body.method === "initialize" ? {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "platform-routing-verifier", version: "1.0.0" },
    } : body.method === "tools/list" ? {
      tools: [{
        name: "run_sub_agent",
        description: "Run a managed platform child agent.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
    } : {};
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    return;
  }
  if (!request.url?.endsWith("/responses")) {
    response.writeHead(404).end();
    return;
  }
  requests.push(body);
  waiters.shift()?.();
  response.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "close",
  });
  response.end(`event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-routing-${requests.length}"}}\n\n`);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-platform-routing-"));
fs.mkdirSync(path.join(root, "home"));
const address = server.address();
const codex = new CodexAppServer({
  mode: "api",
  baseUrl: `http://127.0.0.1:${address.port}`,
  apiKey: "build-verification-placeholder",
  defaultModel: "gpt-5.6-sol",
  codexHome: path.join(root, "home"),
});

function nextModelRequest() {
  if (requests.length > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a model request")), 15_000);
    waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startThread(config) {
  const result = await codex.request("thread/start", {
    cwd: root,
    model: "gpt-5.6-sol",
    modelProvider: "runtime_backend",
    approvalPolicy: "never",
    developerInstructions: "Return without calling tools.",
    ephemeral: true,
    ...(config ? { config } : {}),
  });
  assert.ok(result?.thread?.id, "thread/start must return a thread id");
  return result.thread.id;
}

function toolNames(request) {
  return (request.tools || []).map((tool) => tool.name || tool.function?.name).filter(Boolean);
}

try {
  await codex.start();

  const baselineThread = await startThread();
  await codex.startTurn(baselineThread, "Finish now.", "gpt-5.6-sol");
  await nextModelRequest();
  const baselineRequest = requests.shift();
  const baselineNames = toolNames(baselineRequest);
  const baselineContainsSpawnAgent = JSON.stringify(baselineRequest).includes("spawn_agent");
  assert.ok(
    baselineNames.includes("spawn_agent") || baselineContainsSpawnAgent,
    `baseline must expose native collaboration tools; direct tools: ${baselineNames.join(", ")}`,
  );

  const platformThread = await startThread({
    mcp_servers: { platform: { url: `http://127.0.0.1:${address.port}/mcp` } },
    "features.apps": false,
    "agents.enabled": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
  });
  await codex.startTurn(platformThread, "Finish now.", "gpt-5.6-sol");
  await nextModelRequest();
  const platformRequest = requests.shift();
  const platformNames = toolNames(platformRequest);
  const platformRequestText = JSON.stringify(platformRequest);
  for (const name of ["spawn_agent", "send_input", "resume_agent", "wait", "close_agent"]) {
    assert.ok(!platformNames.includes(name), `platform thread must not expose ${name}`);
  }
  for (const marker of [
    "spawn_agent",
    "send_input",
    "send_message",
    "resume_agent",
    "wait_agent",
    "list_agents",
    "close_agent",
    "multi_agent_v1",
    "multi_agent_v2",
  ]) {
    assert.ok(!platformRequestText.includes(marker), `platform thread must not describe ${marker}`);
  }
  assert.ok(platformRequestText.includes("run_sub_agent"), "platform thread must expose run_sub_agent");
  assert.ok(!platformRequestText.includes("codex_apps."), "platform thread must not expose account apps");
} finally {
  codex.stop();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write("Codex platform routing verification passed\n");
