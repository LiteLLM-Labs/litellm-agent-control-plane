#!/usr/bin/env node
import readline from "node:readline";

let threadCounter = 0;
let turnCounter = 0;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  let result = {};
  if (request.method === "model/list") {
    result = { data: [{ id: "gpt-remote-test", model: "gpt-remote-test", displayName: "Remote test" }] };
  } else if (request.method === "account/read") {
    result = { account: { type: "chatgpt", email: "fixture@example.test", planType: "test" }, requiresOpenaiAuth: true };
  } else if (request.method === "thread/start") {
    result = { thread: { id: `remote-thread-${++threadCounter}` } };
  } else if (request.method === "thread/resume") {
    result = { thread: { id: request.params.threadId } };
  } else if (request.method === "turn/start") {
    const threadId = request.params.threadId;
    const turnId = `remote-turn-${++turnCounter}`;
    result = { turn: { id: turnId } };
    setTimeout(() => {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: `remote-message-${turnCounter}`, delta: "CODEX BRIDGE OK" } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    }, 25);
  }
  send({ id: request.id, result });
});
