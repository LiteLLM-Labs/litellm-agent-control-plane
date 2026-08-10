import assert from "node:assert/strict";
import test from "node:test";

import { textFromEvents, translateNotification } from "../src/protocol.mjs";

test("collects managed-agent user text", () => {
  assert.equal(textFromEvents([
    { type: "ignored", content: "no" },
    { type: "user.message", content: [{ type: "text", text: "hello" }, "world"] },
  ]), "hello\nworld");
});

test("translates message and reasoning deltas", () => {
  assert.deepEqual(
    translateNotification("item/agentMessage/delta", { itemId: "i1", delta: "hello" }, { model: "m1" }),
    [{ event: "agent.message", data: { id: "i1", content: [{ type: "text", text: "hello" }], model: "m1" } }],
  );
  assert.equal(
    translateNotification("item/reasoning/textDelta", { itemId: "r1", delta: "think" })[0].event,
    "agent.thinking",
  );
});

test("translates tool lifecycle and terminal turns", () => {
  const started = translateNotification("item/started", {
    item: { id: "c1", type: "commandExecution", command: "pwd", cwd: "/workspace", status: "inProgress" },
  });
  assert.equal(started[0].event, "agent.tool_use");
  assert.equal(started[0].data.name, "shell");

  const completed = translateNotification("item/completed", {
    item: { id: "c1", type: "commandExecution", aggregatedOutput: "/workspace", exitCode: 0, status: "completed" },
  });
  assert.equal(completed[0].event, "agent.tool_result");
  assert.equal(completed[0].data.output.exit_code, 0);

  assert.equal(translateNotification("turn/completed", { turn: { status: "completed" } })[0].event, "session.status_idle");
  assert.equal(translateNotification("turn/completed", { turn: { status: "failed", error: { message: "bad" } } })[0].event, "session.error");
});

test("does not duplicate a completed message after streaming deltas", () => {
  const messageItems = new Set(["i1"]);
  assert.deepEqual(
    translateNotification("item/completed", { item: { id: "i1", type: "agentMessage", text: "hello" } }, { messageItems }),
    [],
  );
});

test("does not expose the echoed user message as a tool", () => {
  const item = { id: "u1", type: "userMessage", content: [{ type: "text", text: "hello" }] };
  assert.deepEqual(translateNotification("item/started", { item }), []);
  assert.deepEqual(translateNotification("item/completed", { item }), []);
});
