import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRuntime } from "../../../../../../src/open-harness-sdk/server/providers/hermes/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(__dirname, "../../../../../../tests/fixtures/fake-acp-server.mjs");
const FAKE_SLOW = resolve(__dirname, "../../../../../../tests/fixtures/fake-acp-slow.mjs");

function makeSession(overrides = {}) {
  return { sessionId: "sess_test123", mcpServers: [], turns: 1, startedAt: Date.now(), history: [], ...overrides };
}

function fakeEnv(cmd = FAKE) {
  return { ...process.env, HERMES_ACP_COMMAND: `node ${cmd}` };
}

test("runtime: model getter returns provided model", () => {
  const rt = createRuntime({ model: "openrouter/anthropic/claude-sonnet-4-6", env: fakeEnv() });
  assert.equal(rt.model, "openrouter/anthropic/claude-sonnet-4-6");
});

test("runtime: model getter falls back to 'hermes' when none provided", () => {
  const rt = createRuntime({ env: {} });
  assert.equal(rt.model, "hermes");
});

test("runtime: setModel updates the model", () => {
  const rt = createRuntime({ model: "model-a", env: fakeEnv() });
  rt.setModel("model-b");
  assert.equal(rt.model, "model-b");
});

test("runtime: setModel ignores empty/null", () => {
  const rt = createRuntime({ model: "model-a", env: fakeEnv() });
  rt.setModel(null);
  rt.setModel("");
  assert.equal(rt.model, "model-a");
});

test("runtime: runTurn yields stream_event frames then assistant frame", async () => {
  const rt = createRuntime({ env: fakeEnv() });
  const frames = [];
  try {
    for await (const frame of rt.runTurn({ prompt: "hello", session: makeSession() })) {
      frames.push(frame);
    }
  } finally {
    rt.shutdown?.();
  }

  assert.ok(frames.filter((f) => f.type === "stream_event").length > 0, "must yield stream_event frames");
  assert.equal(frames.filter((f) => f.type === "assistant").length, 1, "must yield exactly one assistant frame");
});

test("runtime: stream_event frames match canonical spec", async () => {
  const rt = createRuntime({ env: fakeEnv() });
  try {
    for await (const frame of rt.runTurn({ prompt: "hello", session: makeSession() })) {
      if (frame.type !== "stream_event") continue;
      assert.equal(frame.session_id, "sess_test123");
      assert.equal(frame.event.type, "content_block_delta");
      assert.equal(frame.event.delta.type, "text_delta");
      assert.equal(typeof frame.event.delta.text, "string");
    }
  } finally {
    rt.shutdown?.();
  }
});

test("runtime: assistant frame matches canonical spec", async () => {
  const rt = createRuntime({ env: fakeEnv() });
  let assistantFrame = null;
  try {
    for await (const frame of rt.runTurn({ prompt: "hello", session: makeSession() })) {
      if (frame.type === "assistant") assistantFrame = frame;
    }
  } finally {
    rt.shutdown?.();
  }
  assert.ok(assistantFrame, "assistant frame must be yielded");
  assert.equal(assistantFrame.parent_tool_use_id, null);
  assert.ok(Array.isArray(assistantFrame.message.content));
  assert.equal(assistantFrame.message.content[0].type, "text");
  assert.equal(typeof assistantFrame.message.content[0].text, "string");
});

test("runtime: second runTurn reuses the existing ACP client", async () => {
  const rt = createRuntime({ env: fakeEnv() });
  const session = makeSession();
  try {
    const frames1 = [];
    for await (const f of rt.runTurn({ prompt: "first", session })) frames1.push(f);
    const frames2 = [];
    for await (const f of rt.runTurn({ prompt: "second", session })) frames2.push(f);
    assert.ok(frames1.some((f) => f.type === "assistant"), "first turn yields assistant frame");
    assert.ok(frames2.some((f) => f.type === "assistant"), "second turn yields assistant frame");
  } finally {
    rt.shutdown?.();
  }
});

test("runtime: interrupt stops an in-flight prompt", async () => {
  const rt = createRuntime({ env: fakeEnv(FAKE_SLOW) });
  const session = makeSession();

  const turnPromise = (async () => {
    for await (const frame of rt.runTurn({ prompt: "never ending", session })) { /* drain */ }
  })();

  // Wait for createAcpClient + initialize + session/new + session/prompt to complete
  await new Promise((r) => setTimeout(r, 500));
  rt.interrupt();

  let timeoutId;
  const guard = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("interrupt did not stop the turn within 5s")), 5000);
  });
  try {
    await Promise.race([turnPromise, guard]);
  } finally {
    clearTimeout(timeoutId);
  }

  rt.shutdown?.();
  assert.ok(true, "turn completed after interrupt without hanging");
});

test("runtime: resolveHarness accepts any valid agent string", async () => {
  const { resolveHarness } = await import("../../../../../../src/open-harness-sdk/server/managed-agents/runtime.mjs");
  assert.doesNotThrow(() => resolveHarness("hermes"));
  const { spawnArgs } = resolveHarness("hermes");
  assert.ok(spawnArgs.includes("hermes"), "spawn args include hermes agent");
});

test("runtime: resolveHarness rejects empty/null agent", async () => {
  const { resolveHarness } = await import("../../../../../../src/open-harness-sdk/server/managed-agents/runtime.mjs");
  assert.throws(() => resolveHarness(""), /agent must be/);
  assert.throws(() => resolveHarness(null), /agent must be/);
});
