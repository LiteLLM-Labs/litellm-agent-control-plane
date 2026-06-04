#!/usr/bin/env node
// Fake hermes-acp subprocess for unit/integration tests.
// Speaks the same JSON-RPC 2.0 over stdio protocol as the real hermes-acp.
//
// Behaviour controlled by env:
//   FAKE_CHUNKS          comma-separated chunks (default: "hello ,from ,hermes")
//   FAKE_DELAY_MS        ms delay between chunks (default: 10)
//   FAKE_AGENT           agent name embedded in default chunks (default: "hermes")

import { createInterface } from "node:readline";

const AGENT = process.env.FAKE_AGENT || "hermes";
const DELAY = Number(process.env.FAKE_DELAY_MS) || 10;
const CHUNKS = process.env.FAKE_CHUNKS
  ? process.env.FAKE_CHUNKS.split(",")
  : ["hello ", "from ", AGENT];
const FULL_TEXT = CHUNKS.join("");

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (!msg || typeof msg !== "object") return;

  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });

  } else if (msg.method === "session/new") {
    write({ jsonrpc: "2.0", id: msg.id, result: { session_id: "fake_sess_1" } });

  } else if (msg.method === "session/prompt") {
    for (const chunk of CHUNKS) {
      await sleep(DELAY);
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { type: "agent_message_chunk", text: chunk },
      });
    }
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { type: "agent_message_complete", text: FULL_TEXT },
    });
    write({ jsonrpc: "2.0", id: msg.id, result: { status: "complete" } });

  } else if (msg.method === "session/cancel") {
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});

rl.on("close", () => process.exit(0));
