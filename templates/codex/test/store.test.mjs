import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createStore } from "../src/store.mjs";

test("persists agents, sessions, and ordered events", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-store-"));
  const store = createStore(path.join(dir, "agents.db"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const agent = store.createAgent({ name: "a", model: "m", mcp_servers: [{ name: "tools" }] });
  assert.equal(store.getAgent(agent.id).mcp_servers[0].name, "tools");
  assert.equal(store.updateAgent(agent.id, { system: "updated" }).system, "updated");

  const session = store.createSession({ agent_id: agent.id, thread_id: "thread-1", workspace: "/tmp/work" });
  store.updateSession(session.id, { status: "running", active_turn_id: "turn-1" });
  assert.equal(store.getSessionByThread("thread-1").active_turn_id, "turn-1");

  store.insertEvent(session.id, "event-1", { event: "agent.message", data: { content: [] } });
  store.insertEvent(session.id, "event-1", { event: "duplicate", data: {} });
  const events = store.listEvents(session.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, "event-1");
});
