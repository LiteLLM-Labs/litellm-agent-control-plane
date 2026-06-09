import { test, expect } from "@playwright/test";

// Tests against LOCAL server (port 4000)
const BASE = "http://localhost:4000";
const MASTER_KEY = "sk-local";

async function login(page: import("@playwright/test").Page) {
  await page.goto(`${BASE}/login/`);
  await page.fill('input[id="key"]', MASTER_KEY);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 10000 });
}

test("claude_managed_agents session gets reply via autostartPrompt", async ({ page }) => {
  page.setDefaultTimeout(60000);
  await login(page);

  // Setup: add credential + create agent via API
  await page.request.put(`${BASE}/api/agent-runtimes/claude_managed_agents/credentials`, {
    headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" },
    data: {
      api_key: process.env.ANTHROPIC_API_KEY ?? "",
      api_base: "https://api.anthropic.com",
    },
  });

  const agentResp = await page.request.post(`${BASE}/api/agents`, {
    headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" },
    data: {
      name: "e2e-test",
      description: "test",
      model: "claude-sonnet-4-6",
      runtime: "claude_managed_agents",
      system: "Reply concisely.",
      tools: [],
      owner_id: "default",
    },
  });
  const agent = await agentResp.json();
  const agentId = agent.id as string;
  expect(agentId).toBeTruthy();

  // Create session WITHOUT initial prompt (server side)
  const sessionResp = await page.request.post(`${BASE}/session`, {
    headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" },
    data: { agent_id: agentId, runtime: "claude_managed_agents", title: "e2e" },
  });
  const session = await sessionResp.json();
  const sid = session.id as string;
  expect(sid).toBeTruthy();

  // Navigate to chat with autostartPrompt — this is the fixed flow
  await page.goto(`${BASE}/chat/?id=${encodeURIComponent(sid)}&autostart=1&prompt=say+the+word+PONG`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);

  // Wait up to 30s for assistant reply containing PONG
  await page.screenshot({ path: "/tmp/runtime-before-reply.png" });
  await page.waitForTimeout(25000);
  await page.screenshot({ path: "/tmp/runtime-after-reply.png" });
  const body = await page.textContent("body") ?? "";
  // Check status - session should not be stuck "Waiting for the runtime..."
  const waiting = body.includes("Waiting for the runtime");
  const hasPong = body.includes("PONG");
  console.log("Waiting for runtime:", waiting);
  console.log("Has PONG:", hasPong);
  console.log("Body snippet:", body.slice(body.indexOf("say the word"), body.indexOf("say the word") + 200));
  expect(hasPong && !waiting).toBe(true);
});
