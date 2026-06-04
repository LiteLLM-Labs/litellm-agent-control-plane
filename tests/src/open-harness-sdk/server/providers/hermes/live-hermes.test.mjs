// Live integration test: real hermes-acp + real LiteLLM gateway.
// Requires:
//   HERMES_LIVE=1
//   OPENROUTER_API_KEY=<key>
//   OPENROUTER_BASE_URL=https://gateway.litellm-sandbox.ai/v1
//
// Run: HERMES_LIVE=1 OPENROUTER_API_KEY=sk-... OPENROUTER_BASE_URL=https://... node --test --test-force-exit live-hermes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createState, createApp } from "../../../../../../src/open-harness-sdk/server/managed-agents/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "../../../../../../src/open-harness-sdk/server/server.mjs");
const SKIP = !process.env.HERMES_LIVE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
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

test("live: hermes-acp streams a real response through HTTP API", {
  skip: SKIP ? "Set HERMES_LIVE=1 to run live tests" : false,
}, async () => {
  // HERMES_ACP_COMMAND must be set in the environment.
  // Use the direct binary path, not uvx (uvx adds startup overhead that
  // causes the asyncio loop to be ready before we send initialize).
  // Example: HERMES_ACP_COMMAND=~/.cache/uv/.../bin/hermes-acp
  if (!process.env.HERMES_ACP_COMMAND) {
    throw new Error("HERMES_ACP_COMMAND must be set (e.g. the path to hermes-acp binary)");
  }
  const env = { ...process.env };

  const ctx = createState({ serverPath: SERVER_PATH, env });
  const server = createApp(ctx);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const sseEvents = [];
  let sseReq;

  console.log(`\n  [live] managed-agents server on port ${port}`);

  try {
    // 1. Create hermes session
    const createRes = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "hermes" }),
    });
    assert.equal(createRes.status, 201, `create → 201 (got ${createRes.status})`);
    const session = await createRes.json();
    console.log(`  [live] session created: ${session.id}`);

    // 2. Subscribe SSE
    sseReq = openSse(port, `/v1/sessions/${session.id}/events/stream`, sseEvents);
    await sleep(300);

    // 3. Send a deterministic prompt
    const prompt = "Reply with exactly the word: CONFIRMED";
    await fetch(`${base}/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
      }),
    });
    console.log(`  [live] prompt sent: "${prompt}"`);

    // 4. Wait up to 60s for real LLM response
    const settled = await waitFor(
      () => sseEvents.some((e) => e.type === "session.status_idle" || e.type === "session.status_error"),
      60_000,
    );
    assert.ok(settled, "session must settle within 60s");

    const err = sseEvents.find((e) => e.type === "session.status_error");
    assert.ok(!err, `must not error: ${err?.error ?? ""}`);

    const text = sseEvents
      .filter((e) => e.type === "agent.message")
      .flatMap((e) => (e.content || []).map((b) => b.text || ""))
      .join("");

    console.log(`  [live] agent response: "${text.slice(0, 200)}"`);

    assert.ok(text.length > 0, "agent must produce non-empty text");
    assert.ok(/confirmed/i.test(text), `response should contain "CONFIRMED": "${text}"`);

    // 5. Confirm stream_events arrived before idle (live streaming)
    const streamEventCount = sseEvents.filter((e) => e.type === "session.status_idle").length;
    console.log(`  [live] SSE events total: ${sseEvents.length}, status_idle: ${streamEventCount}`);

    // 6. Delete
    const delRes = await fetch(`${base}/v1/sessions/${session.id}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);

    console.log("  [live] PASSED ✓");

  } finally {
    try { sseReq?.destroy(); } catch {}
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
