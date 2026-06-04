// QA suite: every stream_event and assistant frame emitted by transformation.mjs
// must exactly match the Anthropic canonical wire spec used by the other providers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { transform } from "../../../../../../src/open-harness-sdk/server/providers/hermes/transformation.mjs";

const CTX = { sessionId: "sess_abc123", model: "hermes" };

// ── stream_event shape ───────────────────────────────────────────────────────

test("stream_event: top-level keys match canonical spec exactly", () => {
  const [f] = transform({ type: "agent_message_chunk", text: "hi" }, CTX);
  assert.deepEqual(Object.keys(f).sort(), ["event", "session_id", "type"]);
});

test("stream_event: type === 'stream_event'", () => {
  const [f] = transform({ type: "agent_message_chunk", text: "hi" }, CTX);
  assert.equal(f.type, "stream_event");
});

test("stream_event: session_id matches context", () => {
  const [f] = transform({ type: "agent_message_chunk", text: "hi" }, CTX);
  assert.equal(f.session_id, CTX.sessionId);
});

test("stream_event: event.type === 'content_block_delta'", () => {
  const [f] = transform({ type: "agent_message_chunk", text: "hi" }, CTX);
  assert.equal(f.event.type, "content_block_delta");
});

test("stream_event: event.index is a number", () => {
  const [f] = transform({ type: "agent_message_chunk", text: "hi" }, CTX);
  assert.equal(typeof f.event.index, "number");
});

test("stream_event: event.delta.type === 'text_delta'", () => {
  const [f] = transform({ type: "agent_message_chunk", text: "hi" }, CTX);
  assert.equal(f.event.delta.type, "text_delta");
});

test("stream_event: event.delta.text carries the chunk text", () => {
  const [f] = transform({ type: "agent_message_chunk", text: "hello world" }, CTX);
  assert.equal(f.event.delta.text, "hello world");
});

test("stream_event: event has exactly {type, index, delta}", () => {
  const [f] = transform({ type: "agent_message_chunk", text: "hi" }, CTX);
  assert.deepEqual(Object.keys(f.event).sort(), ["delta", "index", "type"]);
});

test("stream_event: event.delta has exactly {type, text}", () => {
  const [f] = transform({ type: "agent_message_chunk", text: "hi" }, CTX);
  assert.deepEqual(Object.keys(f.event.delta).sort(), ["text", "type"]);
});

// ── assistant frame shape ────────────────────────────────────────────────────

test("assistant: top-level keys match canonical spec exactly", () => {
  const frames = transform({ type: "agent_message_complete", text: "hello" }, CTX);
  const f = frames.find((f) => f.type === "assistant");
  assert.ok(f, "assistant frame must be emitted");
  assert.deepEqual(Object.keys(f).sort(), ["message", "parent_tool_use_id", "type"]);
});

test("assistant: type === 'assistant'", () => {
  const [f] = transform({ type: "agent_message_complete", text: "hello" }, CTX);
  assert.equal(f.type, "assistant");
});

test("assistant: parent_tool_use_id is null for text turns", () => {
  const [f] = transform({ type: "agent_message_complete", text: "hello" }, CTX);
  assert.equal(f.parent_tool_use_id, null);
});

test("assistant: message.content is an array", () => {
  const [f] = transform({ type: "agent_message_complete", text: "hello" }, CTX);
  assert.ok(Array.isArray(f.message.content));
});

test("assistant: message.content[0].type === 'text'", () => {
  const [f] = transform({ type: "agent_message_complete", text: "hello" }, CTX);
  assert.equal(f.message.content[0].type, "text");
});

test("assistant: message.content[0].text matches input", () => {
  const [f] = transform({ type: "agent_message_complete", text: "hello world" }, CTX);
  assert.equal(f.message.content[0].text, "hello world");
});

// ── sequence invariants ──────────────────────────────────────────────────────

test("stream_events appear before assistant frame", () => {
  const all = [
    ...transform({ type: "agent_message_chunk", text: "foo " }, CTX),
    ...transform({ type: "agent_message_chunk", text: "bar" }, CTX),
    ...transform({ type: "agent_message_complete", text: "foo bar" }, CTX),
  ];
  const streamIdx = all.findIndex((f) => f.type === "stream_event");
  const assistantIdx = all.findIndex((f) => f.type === "assistant");
  assert.ok(streamIdx !== -1, "at least one stream_event");
  assert.ok(assistantIdx !== -1, "at least one assistant frame");
  assert.ok(streamIdx < assistantIdx, "stream_events must precede assistant frame");
});

test("no stream_event emitted after assistant frame", () => {
  const all = [
    ...transform({ type: "agent_message_chunk", text: "hello" }, CTX),
    ...transform({ type: "agent_message_complete", text: "hello" }, CTX),
  ];
  const assistantIdx = all.findIndex((f) => f.type === "assistant");
  const lateStream = all.slice(assistantIdx + 1).some((f) => f.type === "stream_event");
  assert.ok(!lateStream, "no stream_event after assistant frame");
});

test("concatenated delta text equals final assistant text", () => {
  const chunks = ["hello ", "world", "!"];
  const all = [
    ...chunks.flatMap((text) => transform({ type: "agent_message_chunk", text }, CTX)),
    ...transform({ type: "agent_message_complete", text: "hello world!" }, CTX),
  ];
  const deltaText = all
    .filter((f) => f.type === "stream_event")
    .map((f) => f.event.delta.text)
    .join("");
  const finalText = all.find((f) => f.type === "assistant")?.message?.content?.[0]?.text ?? "";
  assert.equal(deltaText, finalText, "accumulated deltas must equal final assistant text");
});

test("exactly one assistant frame per agent_message_complete", () => {
  const all = [
    ...transform({ type: "agent_message_chunk", text: "a" }, CTX),
    ...transform({ type: "agent_message_complete", text: "a" }, CTX),
  ];
  assert.equal(all.filter((f) => f.type === "assistant").length, 1);
});

test("session_id is consistent across all stream_event frames", () => {
  const ctx = { sessionId: "sess_xyz", model: "hermes" };
  const all = [
    ...transform({ type: "agent_message_chunk", text: "a" }, ctx),
    ...transform({ type: "agent_message_chunk", text: "b" }, ctx),
    ...transform({ type: "agent_message_chunk", text: "c" }, ctx),
  ];
  for (const f of all.filter((f) => f.type === "stream_event")) {
    assert.equal(f.session_id, "sess_xyz");
  }
});

// ── edge cases ───────────────────────────────────────────────────────────────

test("null input → []", () => {
  assert.deepEqual(transform(null, CTX), []);
});

test("undefined input → []", () => {
  assert.deepEqual(transform(undefined, CTX), []);
});

test("unknown ACP event type → []", () => {
  assert.deepEqual(transform({ type: "some_future_event", data: {} }, CTX), []);
});

test("empty text chunk → [] (no zero-length delta emitted)", () => {
  assert.deepEqual(transform({ type: "agent_message_chunk", text: "" }, CTX), []);
});

test("multi-byte UTF-8 chunk passes through intact", () => {
  const emoji = "🎉";
  const [f] = transform({ type: "agent_message_chunk", text: emoji }, CTX);
  assert.equal(f.event.delta.text, emoji);
});

test("whitespace-only chunk is forwarded (valid content)", () => {
  const [f] = transform({ type: "agent_message_chunk", text: "  \n  " }, CTX);
  assert.equal(f.event.delta.text, "  \n  ");
});

test("agent_message_complete with empty text still emits assistant frame", () => {
  const frames = transform({ type: "agent_message_complete", text: "" }, CTX);
  const f = frames.find((f) => f.type === "assistant");
  assert.ok(f, "assistant frame emitted even for empty completion");
  assert.equal(f.message.content[0].text, "");
});

test("two calls with different sessionIds produce independent frames", () => {
  const ctx1 = { sessionId: "sess_111", model: "hermes" };
  const ctx2 = { sessionId: "sess_222", model: "hermes" };
  const [f1] = transform({ type: "agent_message_chunk", text: "hi" }, ctx1);
  const [f2] = transform({ type: "agent_message_chunk", text: "hi" }, ctx2);
  assert.equal(f1.session_id, "sess_111");
  assert.equal(f2.session_id, "sess_222");
});
