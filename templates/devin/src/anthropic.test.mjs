// Unit tests for the pure ACP -> Anthropic translation logic. Run with:
//   node --test templates/devin/src/anthropic.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  partsFromEvents,
  translateAcpEvent,
  stopReasonEvent,
  runningEvent,
  errorEvent,
  modelId,
  agentResponse,
  sessionResponse,
} from "./anthropic.mjs";

test("partsFromEvents collects text from user.message events", () => {
  const parts = partsFromEvents([
    { type: "user.message", content: "hello" },
    { type: "user.message", content: [{ type: "text", text: "world" }] },
    { type: "other", content: "ignored" },
  ]);
  assert.deepEqual(parts, [
    { type: "text", text: "hello" },
    { type: "text", text: "world" },
  ]);
});

test("partsFromEvents ignores empty content", () => {
  assert.deepEqual(partsFromEvents([{ type: "user.message", content: "" }]), []);
  assert.deepEqual(partsFromEvents([]), []);
});

test("translateAcpEvent maps agent_message_chunk to agent.message", () => {
  const out = translateAcpEvent(
    { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "hi" } },
    { model: "opus" }
  );
  assert.equal(out.event, "agent.message");
  assert.deepEqual(out.data.content, [{ type: "text", text: "hi" }]);
  assert.equal(out.data.model, "opus");
  assert.equal(out.data.messageID, "m1");
});

test("translateAcpEvent drops user_message_chunk", () => {
  assert.equal(
    translateAcpEvent({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "x" } }),
    null
  );
});

test("translateAcpEvent maps agent_thought_chunk to agent.thinking", () => {
  const out = translateAcpEvent(
    { sessionUpdate: "agent_thought_chunk", messageId: "th1", content: { type: "text", text: "hmm" } },
    { model: "opus" }
  );
  assert.equal(out.event, "agent.thinking");
  assert.equal(out.data.thinking, "hmm");
  assert.equal(out.data.content[0].type, "thinking");
  assert.equal(out.data.content[0].text, "hmm");
  assert.equal(out.data.model, "opus");
  assert.equal(out.data.messageID, "th1");
});

test("translateAcpEvent maps a think tool_call to agent.thinking", () => {
  const out = translateAcpEvent(
    { sessionUpdate: "tool_call", toolCallId: "t1", kind: "think", title: "planning..." },
    { model: "opus" }
  );
  assert.equal(out.event, "agent.thinking");
  assert.match(out.data.thinking, /planning/);
});

test("translateAcpEvent maps a non-think tool_call to agent.tool_use", () => {
  const out = translateAcpEvent(
    { sessionUpdate: "tool_call", toolCallId: "t2", kind: "execute", title: "run tests", status: "pending", rawInput: { cmd: "npm test" } },
    { model: "opus" }
  );
  assert.equal(out.event, "agent.tool_use");
  assert.equal(out.data.id, "t2");
  assert.equal(out.data.status, "pending");
  assert.deepEqual(out.data.input, { cmd: "npm test" });
});

test("translateAcpEvent maps completed tool_call_update to agent.tool_result", () => {
  const out = translateAcpEvent(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "t2",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "all green" } }],
    },
    { model: "opus" }
  );
  assert.equal(out.event, "agent.tool_result");
  assert.equal(out.data.tool_use_id, "t2");
  assert.deepEqual(out.data.content, [{ type: "text", text: "all green" }]);
});

test("translateAcpEvent maps in-progress tool_call_update to agent.tool_use", () => {
  const out = translateAcpEvent(
    { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "in_progress" },
    { model: "opus" }
  );
  assert.equal(out.event, "agent.tool_use");
  assert.equal(out.data.id, "t2");
  assert.equal(out.data.status, "in_progress");
});

test("translateAcpEvent maps plan to agent.thinking", () => {
  const out = translateAcpEvent(
    { sessionUpdate: "plan", entries: [{ content: "step a", status: "pending" }, { content: "step b", status: "in_progress" }] },
    { model: "opus" }
  );
  assert.equal(out.event, "agent.thinking");
  assert.match(out.data.thinking, /step a/);
  assert.match(out.data.thinking, /step b/);
});

test("translateAcpEvent drops usage_update and config_option_update", () => {
  assert.equal(translateAcpEvent({ sessionUpdate: "usage_update", used: 1, size: 2 }), null);
  assert.equal(translateAcpEvent({ sessionUpdate: "config_option_update" }), null);
});

test("translateAcpEvent returns null for unknown kinds", () => {
  assert.equal(translateAcpEvent({ sessionUpdate: "mystery" }), null);
  assert.equal(translateAcpEvent(null), null);
});

test("stopReasonEvent maps known stop reasons", () => {
  assert.deepEqual(stopReasonEvent("end_turn"), { event: "session.status_idle", data: { stop_reason: { type: "end_turn" } } });
  assert.deepEqual(stopReasonEvent("cancelled"), { event: "session.status_idle", data: { stop_reason: { type: "cancelled" } } });
  assert.deepEqual(stopReasonEvent(undefined), { event: "session.status_idle", data: { stop_reason: { type: "end_turn" } } });
});

test("runningEvent and errorEvent shapes", () => {
  assert.deepEqual(runningEvent(), { event: "session.status_running", data: {} });
  assert.deepEqual(errorEvent("boom"), { event: "session.error", data: { error: { message: "boom" } } });
});

test("modelId resolves string and object shapes", () => {
  assert.equal(modelId("opus"), "opus");
  assert.equal(modelId({ id: "sonnet" }), "sonnet");
  assert.equal(modelId(null), "");
});

test("agentResponse and sessionResponse shapes", () => {
  const row = { id: "a1", name: "A", system: "s", model: "opus", mcp_servers: [], created_at: 1, updated_at: 2 };
  const a = agentResponse(row);
  assert.equal(a.id, "a1");
  assert.equal(a.type, "agent");
  assert.deepEqual(a.model, { id: "opus" });
  const s = sessionResponse({ id: "s1", agentId: "a1", environmentId: "e1" });
  assert.equal(s.id, "s1");
  assert.equal(s.agent, "a1");
  assert.equal(s.environment_id, "e1");
  assert.equal(s.status, "running");
});
