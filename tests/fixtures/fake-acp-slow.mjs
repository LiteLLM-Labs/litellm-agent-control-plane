#!/usr/bin/env node
// Fake hermes-acp that stalls on session/prompt — for interrupt/cancel tests.
// session/cancel is a NOTIFICATION (no id, no response).
// On cancel, resolves the pending prompt request.

import { createInterface } from "node:readline";

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

let sessionId = null;
let pendingPromptId = null;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (!msg) return;

  // Notifications (no id)
  if (msg.id === undefined) {
    if (msg.method === "session/cancel" && pendingPromptId !== null) {
      // Resolve the hung prompt so the client unblocks
      write({ jsonrpc: "2.0", id: pendingPromptId, result: { sessionId, cancelled: true } });
      pendingPromptId = null;
    }
    return;
  }

  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: "fake-hermes-slow", version: "0.0.1" },
    }});
  } else if (msg.method === "session/new") {
    sessionId = "slow_sess_1";
    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
  } else if (msg.method === "session/prompt") {
    pendingPromptId = msg.id;
    // Never respond until cancelled
  }
});

rl.on("close", () => process.exit(0));
