import { expect, test, type Page } from "@playwright/test";

const sessionId = "ses_large_history";
const agentId = "agent_deep_research";
const runtime = "CodexChargpt";
const answer = `${"x".repeat(1_100)} FINAL RESEARCH RESULT`;

function historyEvents() {
  return {
    data: [
      {
        id: "evt_user",
        type: "user.message",
        content: [{ type: "text", text: "Research the replay path" }],
      },
      { id: "evt_running", type: "session.status_running" },
      ...[...answer].map((text, index) => ({
        id: `evt_message_${index}`,
        item_id: "message_research_result",
        type: "agent.message",
        content: [{ type: "text", text }],
      })),
      { id: "evt_tool", type: "agent.tool_use", name: "webSearch", input: { query: "replay" } },
      { id: "evt_tool_result", type: "agent.tool_result", name: "webSearch", output: "done" },
      { id: "evt_idle", type: "session.status_idle" },
    ],
  };
}

async function mockChatApis(page: Page, historyRequest: () => void) {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("lite-harness-master-key", "sk-test");
  });
  await page.route(`**/v1/sessions/${sessionId}/events`, async (route) => {
    historyRequest();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(historyEvents()) });
  });
  await page.route(`**/session/${sessionId}`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      id: sessionId,
      title: "Deep Researcher replay session",
      agent: agentId,
      agent_id: agentId,
      runtime,
      status: "idle",
      time: { created: Date.now() },
    }),
  }));
  await page.route("**/session", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([{
      id: sessionId,
      title: "Deep Researcher replay session",
      agent: agentId,
      runtime,
      status: "idle",
      time: { created: Date.now() },
    }]),
  }));
  await page.route("**/api/agents", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ agents: [{
      id: agentId,
      name: "Deep Researcher replay",
      model: "gpt-5.6-sol",
      description: "Regression agent",
      system: "Research carefully.",
      config: { runtime },
    }] }),
  }));
  await page.route("**/api/runtime-harnesses", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ harnesses: [{
      alias: runtime,
      api_spec: "claude_managed_agents",
      display_name: runtime,
      api_base: "https://codex.example.test/profiles/chatgpt",
      is_default: false,
      connected: true,
      tools: [],
    }] }),
  }));
  await page.route("**/v1/models**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }),
  }));
  await page.route("**/api/approvals", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ approvals: [] }),
  }));
  await page.route("**/api/inbox**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ items: [] }),
  }));
}

test("replays a large completed runtime history exactly once", async ({ page }) => {
  let historyRequests = 0;
  await mockChatApis(page, () => { historyRequests += 1; });

  await page.goto(`/chat/?id=${sessionId}`);
  await expect(page.getByText("Loading conversation…")).toBeVisible();
  await expect(page.getByText("No messages yet.")).toHaveCount(0);
  await expect(page.getByText("Research the replay path", { exact: true })).toBeVisible();
  await expect(page.getByText(/FINAL RESEARCH RESULT/)).toBeVisible();
  await page.waitForTimeout(1_000);

  expect(historyRequests).toBe(1);
  await expect(page.getByText("No messages yet.")).toHaveCount(0);
});

test("makes recent sessions accessible in the mobile sidebar", async ({ page }) => {
  let historyRequests = 0;
  await page.setViewportSize({ width: 575, height: 900 });
  await mockChatApis(page, () => { historyRequests += 1; });

  await page.goto(`/chat/?id=${sessionId}`);
  await expect(page.getByText(/FINAL RESEARCH RESULT/)).toBeVisible();
  await page.getByRole("button", { name: "Chat" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Recent sessions" })).toBeVisible();
  await expect(dialog.getByText("Deep Researcher replay session", { exact: true })).toBeVisible();
  expect(historyRequests).toBe(1);
});
