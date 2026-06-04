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

test("client sends prompt and yields ACP notification events", async () => {
  const client = await createAcpClient({ env: fakeEnv() });
  const events = [];
  for await (const event of client.prompt({ text: "hello" })) {
    events.push(event);
  }
  client.terminate();

  assert.ok(events.length > 0, "must yield at least one event");
  const chunks = events.filter((e) => e.type === "agent_message_chunk");
  const complete = events.filter((e) => e.type === "agent_message_complete");
  assert.ok(chunks.length > 0, "must yield chunk events");
  assert.equal(complete.length, 1, "must yield exactly one complete event");
});

test("chunk events carry string text", async () => {
  const client = await createAcpClient({ env: fakeEnv() });
  for await (const event of client.prompt({ text: "hello" })) {
    if (event.type === "agent_message_chunk") {
      assert.equal(typeof event.text, "string");
    }
  }
  client.terminate();
});

test("complete event text equals concatenated chunks", async () => {
  const client = await createAcpClient({ env: fakeEnv() });
  const chunks = [];
  let completeText = "";
  for await (const event of client.prompt({ text: "hello" })) {
    if (event.type === "agent_message_chunk") chunks.push(event.text);
    if (event.type === "agent_message_complete") completeText = event.text;
  }
  client.terminate();
  assert.equal(chunks.join(""), completeText);
});

test("cancel stops the prompt generator", async () => {
  const client = await createAcpClient({ env: { ...process.env, HERMES_ACP_COMMAND: `node ${FAKE_SLOW}` } });
  const events = [];

  const gen = client.prompt({ text: "never ending" });

  // Start consuming, then cancel after short delay
  const consumePromise = (async () => {
    for await (const event of gen) {
      events.push(event);
    }
  })();

  await new Promise((r) => setTimeout(r, 50));
  client.cancelActivePrompt();

  await consumePromise;
  client.terminate();

  // Generator should have stopped — may have zero events from slow server
  assert.ok(true, "generator completed after cancel without hanging");
});
