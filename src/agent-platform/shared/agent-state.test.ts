import assert from "node:assert/strict";
import test from "node:test";

import { applyEvent, initState } from "./agent-state";

test("folds full harness message.updated events", () => {
  const state = applyEvent(initState(), {
    type: "message.updated",
    properties: {
      message: {
        info: { id: "msg_1", role: "assistant" },
        parts: [{ id: "p_1", type: "text", text: "streamed assistant" }],
      },
    },
  });

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].role, "assistant");
  assert.equal(state.messages[0].parts[0].text, "streamed assistant");
});

test("folds thinking deltas and tool events into renderable parts", () => {
  let state = initState();
  state = applyEvent(state, {
    type: "message.part.delta",
    properties: {
      messageID: "msg_1",
      partID: "think_1",
      field: "thinking",
      delta: "checking files",
    },
  });
  state = applyEvent(state, {
    type: "agent.tool_use",
    tool_use_id: "tool_1",
    name: "bash",
    input: { command: "pwd" },
  });
  state = applyEvent(state, {
    type: "agent.tool_result",
    tool_use_id: "tool_1",
    content: [{ type: "text", text: "/tmp/project" }],
  });

  const thinking = state.messages[0].parts[0];
  const tool = state.messages[1].parts[0];
  assert.equal(thinking.type, "thinking");
  assert.equal(thinking.text, "checking files");
  assert.equal(tool.type, "tool");
  assert.equal(tool.tool, "bash");
  assert.equal(tool.state?.status, "completed");
  assert.equal(tool.state?.output, "/tmp/project");
});
