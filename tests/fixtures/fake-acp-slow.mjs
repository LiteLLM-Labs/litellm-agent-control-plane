#!/usr/bin/env node
// Fake hermes-acp that stalls on session/prompt and never responds.
// Used to test interrupt/cancel behaviour.
// Responds to session/cancel by rejecting the pending prompt and exiting.

import { createInterface } from "node:readline";

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

let pendingPromptId = null;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (!msg) return;

  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === "session/new") {
    write({ jsonrpc: "2.0", id: msg.id, result: { session_id: "slow_sess_1" } });
  } else if (msg.method === "session/prompt") {
    pendingPromptId = msg.id;
    // Never respond — caller must cancel
  } else if (msg.method === "session/cancel") {
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
    if (pendingPromptId !== null) {
      // Resolve the hung prompt so the client unblocks
      write({ jsonrpc: "2.0", id: pendingPromptId, result: { status: "cancelled" } });
      pendingPromptId = null;
    }
  }
});

rl.on("close", () => process.exit(0));
