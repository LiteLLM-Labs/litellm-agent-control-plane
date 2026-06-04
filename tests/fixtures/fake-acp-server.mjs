#!/usr/bin/env node
// Fake hermes-acp subprocess — speaks real ACP wire protocol (v0.11.2).
//
// Env:
//   FAKE_CHUNKS    comma-separated chunks (default: "hello ,from ,hermes")
//   FAKE_DELAY_MS  ms delay between chunks (default: 10)
//   FAKE_AGENT     agent name in default chunks (default: "hermes")

import { createInterface } from "node:readline";

const AGENT = process.env.FAKE_AGENT || "hermes";
const DELAY = Number(process.env.FAKE_DELAY_MS) || 10;
const CHUNKS = process.env.FAKE_CHUNKS
  ? process.env.FAKE_CHUNKS.split(",")
  : ["hello ", "from ", AGENT];
const FULL_TEXT = CHUNKS.join("");

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sessionId = null;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (!msg || typeof msg !== "object") return;

  // Notifications have no id — session/cancel
  if (msg.id === undefined) {
    if (msg.method === "session/cancel" && sessionId) {
      // Resolve the hung prompt if any (handled in fake-acp-slow.mjs)
    }
    return;
  }

  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: "fake-hermes", version: "0.0.1" },
    }});

  } else if (msg.method === "session/new") {
    sessionId = "fake_sess_1";
    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });

  } else if (msg.method === "session/prompt") {
    // Stream chunks as session/update notifications (real ACP wire format)
    for (const chunk of CHUNKS) {
      await sleep(DELAY);
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",   // discriminator (camelCase alias)
            content: { type: "text", text: chunk },
          },
        },
      });
    }
    // Prompt request resolves — runtime emits final assistant frame from accumulated text
    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
  }
});

rl.on("close", () => process.exit(0));
