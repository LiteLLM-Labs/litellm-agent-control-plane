import assert from "node:assert/strict";
import test from "node:test";

import { opencodeModel, opencodeModelString } from "../src/models.mjs";

test("bare models use the configured default provider", () => {
  assert.deepEqual(opencodeModel("claude-sonnet-4-6", "litellm"), {
    providerID: "litellm",
    modelID: "claude-sonnet-4-6",
  });
});

test("qualified models keep their explicit provider", () => {
  assert.deepEqual(opencodeModel("anthropic/claude-sonnet-4-6", "litellm"), {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
  });
});

test("bare models fall back to opencode defaults without a default provider", () => {
  assert.equal(opencodeModel("claude-sonnet-4-6"), undefined);
});

test("agent config model strings are normalized for opencode", () => {
  assert.equal(
    opencodeModelString("claude-sonnet-4-6", "litellm"),
    "litellm/claude-sonnet-4-6",
  );
});
