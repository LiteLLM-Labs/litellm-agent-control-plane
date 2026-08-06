import assert from "node:assert/strict";
import test from "node:test";

import { runtimeEventForClient } from "../src/app.mjs";

test("gives every streamed delta a unique event id while retaining its Codex item id", () => {
  const first = runtimeEventForClient({
    event_id: "evt_1",
    event: "agent.message",
    data: { id: "msg_1", content: [{ type: "text", text: "Open" }] },
  });
  const second = runtimeEventForClient({
    event_id: "evt_2",
    event: "agent.message",
    data: { id: "msg_1", content: [{ type: "text", text: "AI" }] },
  });

  assert.deepEqual(first, {
    event: "agent.message",
    data: {
      id: "evt_1",
      item_id: "msg_1",
      content: [{ type: "text", text: "Open" }],
    },
  });
  assert.equal(second.data.id, "evt_2");
  assert.equal(second.data.item_id, "msg_1");
});

test("keeps tool correlation ids while assigning a unique event id", () => {
  const event = runtimeEventForClient({
    event_id: "evt_tool_result",
    event: "agent.tool_result",
    data: { id: "call_1", tool_use_id: "call_1", output: "done" },
  });

  assert.equal(event.data.id, "evt_tool_result");
  assert.equal(event.data.item_id, "call_1");
  assert.equal(event.data.tool_use_id, "call_1");
});
