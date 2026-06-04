// End-to-end test: real HTTP managed-agents server + real SSE stream.
// Uses the fake ACP server (HERMES_ACP_COMMAND) — no Hermes installation needed.
//
// Proves the full stack:
//   POST /v1/sessions { agent: "hermes" }
//   POST /v1/sessions/:id/events   (user message)
//   GET  /v1/sessions/:id/events/stream   (SSE — events arrive live)
//
// The SSE client uses node:http (not fetch) because undici buffers
// text/event-stream bodies and won't deliver events live.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  createState,
  createApp,
} from "../../../../../../src/open-harness-sdk/server/managed-agents/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = resolve(__dirname, "../../../../../../tests/fixtures/fake-acp-server.mjs");
const SERVER_PATH = resolve(__dirname, "../../../../../../src/open-harness-sdk/server/server.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(40);
  }
  return false;
}

function openSse(port, path, sink) {
  const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const line of parts) {
        if (!line.startsWith("data: ")) continue;
        const json = line.slice(6).trim();
        if (!json) continue;
        try { sink.push(JSON.parse(json)); } catch { /* partial */ }
      }
    });
  });
  req.on("error", () => {});
  return req;
}

test("e2e: hermes session streams live events through HTTP API", async () => {
  const env = {
    ...process.env,
    HERMES_ACP_COMMAND: `node ${FAKE_ACP}`,
    FAKE_AGENT: "hermes",
  };

  const ctx = createState({ serverPath: SERVER_PATH, env });
  const server = createApp(ctx);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const sseEvents = [];
  let sseReq;

  try {
    // 1. Create hermes session
    const createRes = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "hermes" }),
    });
    assert.equal(createRes.status, 201, "POST /v1/sessions → 201");
    const session = await createRes.json();
    assert.ok(typeof session.id === "string", `session.id must be string, got: ${session.id}`);

    // 2. Open SSE stream before sending message (ensures no events are missed)
    sseReq = openSse(port, `/v1/sessions/${session.id}/events/stream`, sseEvents);
    await sleep(150);

    // 3. Send user message
    const sendRes = await fetch(`${base}/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: "hello hermes" }] }],
      }),
    });
    assert.equal(sendRes.status, 200, "POST /v1/sessions/:id/events → 200");

    // 4. Wait for turn to complete
    const settled = await waitFor(
      () => sseEvents.some((e) => e.type === "session.status_idle" || e.type === "session.status_error"),
      10_000
    );
    assert.ok(settled, "session must settle within 10s");

    // 5. No errors
    const errEvent = sseEvents.find((e) => e.type === "session.status_error");
    assert.ok(!errEvent, `session must not error: ${errEvent?.error ?? ""}`);

    // 6. agent.message arrived with non-empty text
    const agentMsg = sseEvents.find((e) => e.type === "agent.message");
    assert.ok(agentMsg, "agent.message must arrive on SSE stream");
    const text = (agentMsg.content || []).map((b) => b.text || "").join("");
    assert.ok(text.length > 0, "agent.message must have non-empty text");
    assert.ok(text.includes("hermes"), `text should contain "hermes": "${text}"`);

    // 7. Confirm events arrived LIVE (before status_idle, not after)
    const msgIdx = sseEvents.findIndex((e) => e.type === "agent.message");
    const idleIdx = sseEvents.findIndex((e) => e.type === "session.status_idle");
    assert.ok(msgIdx < idleIdx, "agent.message must arrive before session.status_idle");

    // 8. History contains both user and agent messages
    const histRes = await fetch(`${base}/v1/sessions/${session.id}/events`);
    const history = await histRes.json();
    assert.ok(history.data.some((e) => e.type === "user.message"), "history has user.message");
    assert.ok(history.data.some((e) => e.type === "agent.message"), "history has agent.message");

    // 9. DELETE succeeds
    const delRes = await fetch(`${base}/v1/sessions/${session.id}`, { method: "DELETE" });
    assert.equal(delRes.status, 200, "DELETE → 200");
    assert.equal((await delRes.json()).deleted, true);

  } finally {
    try { sseReq?.destroy(); } catch { /* ignore */ }
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test("e2e: POST /v1/sessions with agent 'hermes' returns 201 (not 400 unknown harness)", async () => {
  const env = { ...process.env, HERMES_ACP_COMMAND: `node ${FAKE_ACP}` };
  const ctx = createState({ serverPath: SERVER_PATH, env });
  const server = createApp(ctx);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "hermes" }),
    });
    assert.equal(res.status, 201, "hermes must be accepted as a valid agent");
    const body = await res.json();
    assert.equal(body.agent, "hermes");
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
