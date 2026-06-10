// Route-level tests for the Anthropic Managed Agents surface in app.mjs.
//
// The opencode child and provider-config writers are faked via injected deps,
// so these tests exercise the real Express routing + the real (in-memory)
// SQLite store without booting `opencode serve`. The focus is the per-agent
// model contract: a string model on POST /v1/agents must survive storage,
// read-back, and reach opencode's prompt_async as a normalized provider/model.
import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createStore } from "../src/store.mjs";

// A minimal fetch-Response stand-in for the opencode fake.
function fakeRes(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Build the app with fake opencode collaborators and capture their calls.
function buildHarness() {
  const store = createStore(":memory:");
  const calls = { ocFetch: [], provisionAgent: [], ensureProviderModel: [], reboots: 0 };

  const app = createApp({
    store,
    workdir: "/tmp/test-workspace",
    defaultModelProviderID: "litellm",
    litellmProviderID: "litellm",
    ensureProviderModel: async (cwd, model) => {
      calls.ensureProviderModel.push({ cwd, model });
    },
    provisionAgent: async (cwd, agent) => {
      calls.provisionAgent.push({ cwd, agent });
    },
    writeMcpConfig: async () => {},
    rebootOpencode: async () => {
      calls.reboots += 1;
    },
    ocBase: async () => "http://fake-opencode",
    ocFetch: async (baseUrl, path, init) => {
      calls.ocFetch.push({ path, init });
      if (path === "/session") return fakeRes({ id: "ses_test" });
      if (path.endsWith("/prompt_async")) return fakeRes({ ok: true });
      return fakeRes({});
    },
    checkOpencode: async () => true,
  });

  return { app, store, calls };
}

// Start the app on an ephemeral port and return a base URL + closer.
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

async function req(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

test("per-agent gpt-5.5 model flows from create through prompt_async", async (t) => {
  const { app, calls } = buildHarness();
  const { base, close } = await listen(app);
  t.after(() => close());

  // 1. POST /v1/agents with a string model stores the model string.
  const created = await req(base, "POST", "/v1/agents", {
    name: "GPT Agent",
    model: "gpt-5.5",
    system: "You are terse.",
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.model.id, "gpt-5.5");
  const agentId = created.json.id;
  assert.ok(agentId, "agent id returned");

  // The LiteLLM-routed bare model is registered before provisioning, and the
  // agent config is provisioned with the normalized provider/model string.
  assert.deepEqual(calls.ensureProviderModel.at(-1).model, {
    providerID: "litellm",
    modelID: "gpt-5.5",
  });
  assert.equal(calls.provisionAgent.at(-1).agent.model, "litellm/gpt-5.5");

  // 2. GET /v1/agents/:id returns the created agent with that model.
  const fetched = await req(base, "GET", `/v1/agents/${agentId}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.model.id, "gpt-5.5");

  // 3. POST /v1/sessions binds the session to the agent.
  const session = await req(base, "POST", "/v1/sessions", { agent: agentId });
  assert.equal(session.status, 200);
  assert.equal(session.json.id, "ses_test");
  assert.equal(session.json.agent, agentId);

  // 4. POST /v1/sessions/:id/events calls opencode prompt_async with the
  //    normalized model for that agent.
  const events = await req(base, "POST", "/v1/sessions/ses_test/events", {
    events: [{ type: "user.message", content: "Say hello." }],
  });
  assert.equal(events.status, 202);

  const prompt = calls.ocFetch.find((c) => c.path.endsWith("/prompt_async"));
  assert.ok(prompt, "prompt_async was called");
  const sent = JSON.parse(prompt.init.body);
  assert.equal(sent.agent, agentId);
  assert.deepEqual(sent.model, { providerID: "litellm", modelID: "gpt-5.5" });
  assert.deepEqual(sent.parts, [{ type: "text", text: "Say hello." }]);
});

test("litellm/gpt-5.5 keeps its explicit provider split end to end", async (t) => {
  const { app, calls } = buildHarness();
  const { base, close } = await listen(app);
  t.after(() => close());

  const created = await req(base, "POST", "/v1/agents", {
    name: "Explicit",
    model: "litellm/gpt-5.5",
    system: "",
  });
  assert.equal(created.json.model.id, "litellm/gpt-5.5");
  assert.equal(calls.provisionAgent.at(-1).agent.model, "litellm/gpt-5.5");

  await req(base, "POST", "/v1/sessions", { agent: created.json.id });
  await req(base, "POST", "/v1/sessions/ses_test/events", {
    events: [{ type: "user.message", content: "hi" }],
  });

  const prompt = calls.ocFetch.find((c) => c.path.endsWith("/prompt_async"));
  const sent = JSON.parse(prompt.init.body);
  assert.deepEqual(sent.model, { providerID: "litellm", modelID: "gpt-5.5" });
});

test("POST /v1/sessions rejects an unknown agent", async (t) => {
  const { app } = buildHarness();
  const { base, close } = await listen(app);
  t.after(() => close());

  const session = await req(base, "POST", "/v1/sessions", { agent: "agt_missing" });
  assert.equal(session.status, 400);
  assert.match(session.json.error, /unknown agent/);
});
