// Unit tests for devin.mjs helpers and models.mjs normalization. Run with:
//   node --test templates/devin/src/devin.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { toAcpMcpServers } from "./devin.mjs";
import { devinModel, devinModelString } from "./models.mjs";

test("toAcpMcpServers maps stdio entries", () => {
  const out = toAcpMcpServers([
    { name: "fs", command: "npx", args: ["-y", "fs-server"], env: [{ name: "X", value: "1" }] },
  ]);
  assert.deepEqual(out, [
    { name: "fs", command: "npx", args: ["-y", "fs-server"], env: [{ name: "X", value: "1" }] },
  ]);
});

test("toAcpMcpServers maps http/url entries", () => {
  const out = toAcpMcpServers([{ name: "notion", url: "https://mcp.notion.com/mcp" }]);
  assert.deepEqual(out, [{ name: "notion", type: "http", url: "https://mcp.notion.com/mcp" }]);
});

test("toAcpMcpServers drops entries without a name or a command/url", () => {
  assert.deepEqual(toAcpMcpServers([{ command: "x" }]), []);
  assert.deepEqual(toAcpMcpServers([{ name: "empty" }]), []);
  assert.deepEqual(toAcpMcpServers(null), []);
});

test("devinModel trims and validates", () => {
  assert.equal(devinModel("  opus  "), "opus");
  assert.equal(devinModel(""), undefined);
  assert.equal(devinModel(null), undefined);
});

test("devinModelString strips a leading devin/ provider prefix", () => {
  assert.equal(devinModelString("devin/opus"), "opus");
  assert.equal(devinModelString("DEVIN/Sonnet"), "Sonnet");
  assert.equal(devinModelString("opus"), "opus");
  assert.equal(devinModelString(""), "");
});
