import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureProviderModel, writeMcpConfig, writeProviderConfig } from "../src/opencode.mjs";

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

test("ensureProviderModel registers gpt-5.5 while preserving existing models", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "opencode-provider-"));
  try {
    await writeProviderConfig(cwd, {
      id: "litellm",
      baseURL: "https://gateway.example/v1",
      apiKey: "test-key",
      models: ["claude-sonnet-4-6"],
    });
    await ensureProviderModel(cwd, { providerID: "litellm", modelID: "gpt-5.5" });

    const config = JSON.parse(await readFile(path.join(cwd, "opencode.json"), "utf8"));
    assert.deepEqual(Object.keys(config.provider.litellm.models).sort(), [
      "claude-sonnet-4-6",
      "gpt-5.5",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// --- writeMcpConfig: gateway-key fallback for LAP-hosted MCP servers ---------

/** Run `fn` with LITELLM_* env set, restoring the previous values afterwards. */
async function withGatewayEnv({ baseURL, apiKey }, fn) {
  const prevBase = process.env.LITELLM_BASE_URL;
  const prevKey = process.env.LITELLM_API_KEY;
  process.env.LITELLM_BASE_URL = baseURL;
  process.env.LITELLM_API_KEY = apiKey;
  try {
    return await fn();
  } finally {
    if (prevBase === undefined) delete process.env.LITELLM_BASE_URL;
    else process.env.LITELLM_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = prevKey;
  }
}

async function mcpConfigFor(servers, env = {
  baseURL: "http://lap:4000/v1",
  apiKey: "sk-gateway",
}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "opencode-mcp-"));
  try {
    await withGatewayEnv(env, () =>
      writeMcpConfig(cwd, [{ mcp_servers: servers }]),
    );
    const config = JSON.parse(await readFile(path.join(cwd, "opencode.json"), "utf8"));
    return config.mcp;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("writeMcpConfig attaches the gateway key to LAP's own MCP endpoint", async () => {
  const mcp = await mcpConfigFor([
    { name: "github", url: "http://lap:4000/github/mcp" },
  ]);
  assert.equal(mcp.github.headers.Authorization, "Bearer sk-gateway");
});

test("writeMcpConfig does not leak the gateway key to a same-origin non-LAP path", async () => {
  // Gateway mounted under a path on a shared host; an unrelated MCP service on
  // the same origin must not receive the (possibly master) gateway key.
  const mcp = await mcpConfigFor(
    [{ name: "vendor", url: "https://co.example/customer-mcp" }],
    { baseURL: "https://co.example/litellm/v1", apiKey: "sk-master" },
  );
  assert.equal(mcp.vendor.headers, undefined);
});

test("writeMcpConfig still recognises LAP under a path-mounted gateway", async () => {
  const mcp = await mcpConfigFor(
    [{ name: "github", url: "https://co.example/litellm/github/mcp" }],
    { baseURL: "https://co.example/litellm/v1", apiKey: "sk-master" },
  );
  assert.equal(mcp.github.headers.Authorization, "Bearer sk-master");
});

test("writeMcpConfig never attaches the key to another origin", async () => {
  const mcp = await mcpConfigFor([
    { name: "vendor", url: "https://mcp.vendor.example/mcp" },
  ]);
  assert.equal(mcp.vendor.headers, undefined);
});

test("writeMcpConfig adds auth alongside a non-auth header", async () => {
  // A custom header such as x-tenant must not suppress the credential.
  const mcp = await mcpConfigFor([
    { name: "github", url: "http://lap:4000/github/mcp", headers: { "x-tenant": "a" } },
  ]);
  assert.equal(mcp.github.headers["x-tenant"], "a");
  assert.equal(mcp.github.headers.Authorization, "Bearer sk-gateway");
});

test("writeMcpConfig preserves an explicit auth header instead of overwriting it", async () => {
  const mcp = await mcpConfigFor([
    { name: "github", url: "http://lap:4000/github/mcp", headers: { Authorization: "Bearer caller" } },
  ]);
  assert.equal(mcp.github.headers.Authorization, "Bearer caller");
});

test("writeMcpConfig treats a lowercase x-api-key as existing auth", async () => {
  const mcp = await mcpConfigFor([
    { name: "github", url: "http://lap:4000/github/mcp", headers: { "x-api-key": "caller" } },
  ]);
  assert.equal(mcp.github.headers.Authorization, undefined);
  assert.equal(mcp.github.headers["x-api-key"], "caller");
});

test("writeMcpConfig attaches the gateway key to LAP platform MCP URLs", async () => {
  // LAP serves platform MCPs at /mcp/platform/{agent_id}, which also enforces
  // require_any_gateway_key — so this route needs the credential too.
  const mcp = await mcpConfigFor([
    {
      name: "platform",
      url: "http://lap:4000/mcp/platform/agent_1?session_id=ses_1",
    },
  ]);
  assert.equal(mcp.platform.headers.Authorization, "Bearer sk-gateway");
});

test("writeMcpConfig ignores a query string when matching LAP routes", async () => {
  const mcp = await mcpConfigFor([
    { name: "github", url: "http://lap:4000/github/mcp?x=1" },
  ]);
  assert.equal(mcp.github.headers.Authorization, "Bearer sk-gateway");
});
