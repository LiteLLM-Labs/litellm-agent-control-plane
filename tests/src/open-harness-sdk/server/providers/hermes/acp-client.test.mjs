import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createAcpClient } from "../../../../../../src/open-harness-sdk/server/providers/hermes/acp-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(__dirname, "../../../../../../tests/fixtures/fake-acp-server.mjs");
const FAKE_SLOW = resolve(__dirname, "../../../../../../tests/fixtures/fake-acp-slow.mjs");

function fakeEnv(cmd = FAKE) {
  return { ...process.env, HERMES_ACP_COMMAND: `node ${cmd}` };
}

test("client initializes successfully with fake ACP server", async () => {
  const client = await createAcpClient({ env: fakeEnv() });
  assert.ok(client, "client created");
  client.terminate();
});

test("client throws clear error when command is not found", async () => {
  await assert.rejects(
    () => createAcpClient({ env: { ...process.env, HERMES_ACP_COMMAND: "this-command-does-not-exist-xyzzy" } }),
    (err) => {
      assert.ok(err.message.includes("not found") || err.message.includes("ENOENT"), err.message);
      return true;
    }
  );
});

test("client sends prompt and yields ACP session/update notification events", async () => {
  const client = await createAcpClient({ env: fakeEnv() });
  const events = [];
  for await (const event of client.prompt({ text: "hello" })) {
    events.push(event);
  }
  client.terminate();

  assert.ok(events.length > 0, "must yield at least one event");
  // Events are SessionNotification params: { sessionId, update: { sessionUpdate, content } }
  for (const e of events) {
    assert.ok(e.sessionId, "each event must have sessionId");
    assert.ok(e.update, "each event must have update");
    assert.equal(e.update.sessionUpdate, "agent_message_chunk");
  }
});

test("chunk events carry text in update.content.text", async () => {
  const client = await createAcpClient({ env: fakeEnv() });
  const texts = [];
  for await (const event of client.prompt({ text: "hello" })) {
    texts.push(event.update.content.text);
  }
  client.terminate();
  assert.ok(texts.length > 0, "must have text chunks");
  for (const t of texts) {
    assert.equal(typeof t, "string");
  }
});

test("concatenated chunk texts form the expected full response", async () => {
  const client = await createAcpClient({ env: fakeEnv() });
  const texts = [];
  for await (const event of client.prompt({ text: "hello" })) {
    texts.push(event.update.content.text);
  }
  client.terminate();
  const full = texts.join("");
  assert.ok(full.includes("hermes"), `full text "${full}" should contain "hermes"`);
});

test("cancel stops the prompt generator", async () => {
  const client = await createAcpClient({ env: fakeEnv(FAKE_SLOW) });
  const events = [];

  const gen = client.prompt({ text: "never ending" });
  const consumePromise = (async () => {
    for await (const event of gen) events.push(event);
  })();

  await new Promise((r) => setTimeout(r, 200));
  client.cancelActivePrompt();

  let timeoutId;
  const guard = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("cancel did not stop generator within 3s")), 3000);
  });
  try {
    await Promise.race([consumePromise, guard]);
  } finally {
    clearTimeout(timeoutId);
  }

  client.terminate();
  assert.ok(true, "generator completed after cancel");
});
