import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureProviderModel, writeProviderConfig } from "../src/opencode.mjs";

test("ensureProviderModel adds newly requested LiteLLM models", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "opencode-provider-"));
  try {
    await writeProviderConfig(cwd, {
      id: "litellm",
      baseURL: "https://gateway.example/v1",
      apiKey: "test-key",
      models: ["claude-sonnet-4-5"],
    });
    await ensureProviderModel(cwd, {
      providerID: "litellm",
      modelID: "claude-sonnet-4-6",
    });

    const config = JSON.parse(await readFile(path.join(cwd, "opencode.json"), "utf8"));
    assert.deepEqual(Object.keys(config.provider.litellm.models).sort(), [
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
