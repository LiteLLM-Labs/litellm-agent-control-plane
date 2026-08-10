import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp, runtimeEventForClient } from "../src/app.mjs";
import { createStore } from "../src/store.mjs";

test("gives every streamed delta a unique event id while retaining its Codex item id", () => {
  const first = runtimeEventForClient({
    event_id: "evt_1",
    event: "agent.message",
    data: { id: "msg_1", content: [{ type: "text", text: "Open" }] },
  });
  const second = runtimeEventForClient({
    event_id: "evt_2",
    event: "agent.message",
    data: { id: "msg_1", content: [{ type: "text", text: "AI" }] },
  });

  assert.deepEqual(first, {
    event: "agent.message",
    data: {
      id: "evt_1",
      item_id: "msg_1",
      content: [{ type: "text", text: "Open" }],
    },
  });
  assert.equal(second.data.id, "evt_2");
  assert.equal(second.data.item_id, "msg_1");
});

test("keeps tool correlation ids while assigning a unique event id", () => {
  const event = runtimeEventForClient({
    event_id: "evt_tool_result",
    event: "agent.tool_result",
    data: { id: "call_1", tool_use_id: "call_1", output: "done" },
  });

  assert.equal(event.data.id, "evt_tool_result");
  assert.equal(event.data.item_id, "call_1");
  assert.equal(event.data.tool_use_id, "call_1");
});

test("forwards the stored agent MCP servers when creating a Codex thread", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-app-"));
  const store = createStore(path.join(root, "agents.db"));
  const codex = new EventEmitter();
  let threadInput;
  codex.healthy = () => true;
  codex.startThread = async (input) => {
    threadInput = input;
    return { thread: { id: "thread-with-mcp" } };
  };
  const app = createApp({
    store,
    codex,
    workspaceRoot: root,
    defaultModel: "gpt-test",
    listModels: async () => ({ data: [] }),
    runtimeApiKey: "test-key",
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => {
    server.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "content-type": "application/json", "x-api-key": "test-key" };
  const agentResponse = await fetch(`${base}/v1/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "SimpleFIN",
      model: { id: "gpt-test" },
      mcp_servers: [{ type: "url", name: "simplefin", url: "https://simplefin.example.test/mcp" }],
    }),
  });
  assert.equal(agentResponse.status, 200);
  const agent = await agentResponse.json();
  const sessionResponse = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: agent.id }),
  });
  assert.equal(sessionResponse.status, 200);
  assert.deepEqual(threadInput.mcpServers, [
    { type: "url", name: "simplefin", url: "https://simplefin.example.test/mcp" },
  ]);
});
