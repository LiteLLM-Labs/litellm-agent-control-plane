// QA suite: every stream_event and assistant frame produced by transformation.mjs
// must exactly match the Anthropic canonical wire spec used by other providers.
//
// Input format mirrors the real ACP wire: SessionNotification params with
//   update.sessionUpdate discriminator and update.content.text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { transform, finalAssistantFrame } from "../../../../../../src/open-harness-sdk/server/providers/hermes/transformation.mjs";

const CTX = { sessionId: "sess_abc123", model: "hermes" };

// Helper: build a real ACP session/update notification params object
function chunk(text) {
  return {
    sessionId: "sess_abc123",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  };
}

// ── stream_event shape ───────────────────────────────────────────────────────

test("stream_event: top-level keys match canonical spec exactly", () => {
  const [f] = transform(chunk("hi"), CTX);
  assert.deepEqual(Object.keys(f).sort(), ["event", "session_id", "type"]);
});

test("stream_event: type === 'stream_event'", () => {
  const [f] = transform(chunk("hi"), CTX);
  assert.equal(f.type, "stream_event");
});

test("stream_event: session_id matches context", () => {
  const [f] = transform(chunk("hi"), CTX);
  assert.equal(f.session_id, CTX.sessionId);
});

test("stream_event: event.type === 'content_block_delta'", () => {
  const [f] = transform(chunk("hi"), CTX);
  assert.equal(f.event.type, "content_block_delta");
});

test("stream_event: event.index is a number", () => {
  const [f] = transform(chunk("hi"), CTX);
  assert.equal(typeof f.event.index, "number");
});

test("stream_event: event.delta.type === 'text_delta'", () => {
  const [f] = transform(chunk("hi"), CTX);
  assert.equal(f.event.delta.type, "text_delta");
});

test("stream_event: event.delta.text carries the chunk text", () => {
  const [f] = transform(chunk("hello world"), CTX);
  assert.equal(f.event.delta.text, "hello world");
});

test("stream_event: event has exactly {type, index, delta}", () => {
  const [f] = transform(chunk("hi"), CTX);
  assert.deepEqual(Object.keys(f.event).sort(), ["delta", "index", "type"]);
});

test("stream_event: event.delta has exactly {type, text}", () => {
  const [f] = transform(chunk("hi"), CTX);
  assert.deepEqual(Object.keys(f.event.delta).sort(), ["text", "type"]);
});

// ── finalAssistantFrame shape ────────────────────────────────────────────────

test("assistant: top-level keys match canonical spec exactly", () => {
  const f = finalAssistantFrame("hello", CTX);
  assert.deepEqual(Object.keys(f).sort(), ["message", "parent_tool_use_id", "type"]);
});

test("assistant: type === 'assistant'", () => {
  const f = finalAssistantFrame("hello", CTX);
  assert.equal(f.type, "assistant");
});

test("assistant: parent_tool_use_id is null for text turns", () => {
  const f = finalAssistantFrame("hello", CTX);
  assert.equal(f.parent_tool_use_id, null);
});

test("assistant: message.content is an array", () => {
  const f = finalAssistantFrame("hello", CTX);
  assert.ok(Array.isArray(f.message.content));
});

test("assistant: message.content[0].type === 'text'", () => {
  const f = finalAssistantFrame("hello", CTX);
  assert.equal(f.message.content[0].type, "text");
});

test("assistant: message.content[0].text matches input", () => {
  const f = finalAssistantFrame("hello world", CTX);
  assert.equal(f.message.content[0].text, "hello world");
});

// ── sequence invariants ──────────────────────────────────────────────────────

test("stream_events appear before assistant frame in a complete turn", () => {
  const all = [
    ...transform(chunk("foo "), CTX),
    ...transform(chunk("bar"), CTX),
    finalAssistantFrame("foo bar", CTX),
  ];
  const streamIdx = all.findIndex((f) => f.type === "stream_event");
  const assistantIdx = all.findIndex((f) => f.type === "assistant");
  assert.ok(streamIdx !== -1, "at least one stream_event");
  assert.ok(assistantIdx !== -1, "at least one assistant frame");
  assert.ok(streamIdx < assistantIdx, "stream_events must precede assistant frame");
});

test("concatenated delta text equals finalAssistantFrame text", () => {
  const chunks = ["hello ", "world", "!"];
  const streamFrames = chunks.flatMap((t) => transform(chunk(t), CTX));
  const assistantFrame = finalAssistantFrame("hello world!", CTX);

  const deltaText = streamFrames
    .filter((f) => f.type === "stream_event")
    .map((f) => f.event.delta.text)
    .join("");
  assert.equal(deltaText, assistantFrame.message.content[0].text);
});

test("session_id consistent across all stream_event frames", () => {
  const ctx = { sessionId: "sess_xyz", model: "hermes" };
  const all = [chunk("a"), chunk("b"), chunk("c")].flatMap((e) => transform(e, ctx));
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

test("missing update field → []", () => {
  assert.deepEqual(transform({ sessionId: "s" }, CTX), []);
});

test("unknown sessionUpdate type → []", () => {
  assert.deepEqual(transform({
    sessionId: "s",
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } },
  }, CTX), []);
});

test("empty text chunk → [] (no zero-length delta emitted)", () => {
  assert.deepEqual(transform(chunk(""), CTX), []);
});

test("multi-byte UTF-8 chunk passes through intact", () => {
  const [f] = transform(chunk("🎉"), CTX);
  assert.equal(f.event.delta.text, "🎉");
});

test("whitespace-only chunk is forwarded (valid content)", () => {
  const [f] = transform(chunk("  \n  "), CTX);
  assert.equal(f.event.delta.text, "  \n  ");
});

test("finalAssistantFrame with empty text still produces assistant frame", () => {
  const f = finalAssistantFrame("", CTX);
  assert.equal(f.type, "assistant");
  assert.equal(f.message.content[0].text, "");
});

test("two calls with different sessionIds produce independent frames", () => {
  const ctx1 = { sessionId: "sess_111", model: "hermes" };
  const ctx2 = { sessionId: "sess_222", model: "hermes" };
  const [f1] = transform(chunk("hi"), ctx1);
  const [f2] = transform(chunk("hi"), ctx2);
  assert.equal(f1.session_id, "sess_111");
  assert.equal(f2.session_id, "sess_222");
});
