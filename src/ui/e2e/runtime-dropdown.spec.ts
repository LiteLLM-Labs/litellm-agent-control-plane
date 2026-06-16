import { expect, test, type Page } from "@playwright/test";

const runtimeHarnesses = [
  {
    alias: "claude_managed_agents",
    api_spec: "claude_managed_agents",
    display_name: "Claude Agents",
    api_base: "https://api.anthropic.com",
    is_default: true,
    connected: false,
    masked_api_key: null,
    tools: [],
  },
  {
    alias: "cursor",
    api_spec: "cursor",
    display_name: "Cursor",
    api_base: "https://api.cursor.com",
    is_default: true,
    connected: false,
    masked_api_key: null,
    tools: [],
  },
  {
    alias: "gemini_antigravity",
    api_spec: "gemini_antigravity",
    display_name: "Gemini Antigravity",
    api_base: "https://generativelanguage.googleapis.com",
    is_default: true,
    connected: false,
    masked_api_key: null,
    tools: [],
  },
  {
    alias: "elastic_agent_builder",
    api_spec: "elastic_agent_builder",
    display_name: "Elastic Agent Builder",
    api_base: "http://localhost:5601",
    is_default: true,
    connected: false,
    masked_api_key: null,
    tools: [],
  },
  {
    alias: "local-openclaw",
    api_spec: "claude_managed_agents",
    display_name: "local-openclaw",
    api_base: "http://localhost:3001",
    is_default: false,
    connected: true,
    masked_api_key: "sk-...test",
    tools: [],
  },
  {
    alias: "local-openclaw-docker",
    api_spec: "claude_managed_agents",
    display_name: "local-openclaw-docker",
    api_base: "http://localhost:3002",
    is_default: false,
    connected: true,
    masked_api_key: "sk-...test",
    tools: [],
  },
];

async function mockSessionsPage(page: Page, agents: unknown[] = []) {
  await page.route("**/api/runtime-harnesses", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ harnesses: runtimeHarnesses }),
    });
  });
  await page.route("**/api/inbox**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });
  await page.route("**/session", async (route) => {
    await route.fulfill({ contentType: "application/json", body: "[]" });
  });
  await page.route("**/api/agents", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ agents }) });
  });
}

test.describe("Runtime dropdown", () => {
  test("shows only configured runtimes in the composer", async ({ page }) => {
    await mockSessionsPage(page);

    await page.goto("/sessions/");
    const runtimeSelect = page.getByRole("combobox").filter({ hasText: "Runtime" });
    await expect(runtimeSelect).toContainText("local-openclaw");

    await runtimeSelect.click();

    const runtimeOptions = page.getByRole("option");
    await expect(runtimeOptions).toHaveCount(2);
    await expect(runtimeOptions.nth(0)).toContainText("local-openclaw");
    await expect(runtimeOptions.nth(1)).toContainText("local-openclaw-docker");
    await expect(page.getByText("Claude Agents", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Cursor", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Gemini Antigravity", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Elastic Agent Builder", { exact: true })).toHaveCount(0);
    await expect(page.getByText("missing key")).toHaveCount(0);
    await expect(
      page.getByText("Go to AI Gateway > Agent Runtimes to configure more runtimes."),
    ).toBeVisible();
  });

  test("falls back when a saved agent uses a disconnected runtime", async ({ page }) => {
    await mockSessionsPage(page, [
      {
        id: "agent_cursor_disconnected",
        name: "Cursor saved agent",
        harness: "claude-code",
        config: { runtime: "cursor" },
      },
    ]);

    await page.goto("/sessions/");
    await page.getByRole("combobox").filter({ hasText: "Agent" }).click();
    await page.getByRole("option").filter({ hasText: "Cursor saved agent" }).click();

    const runtimeSelect = page.getByRole("combobox").filter({ hasText: "Runtime" });
    await expect(runtimeSelect).toContainText("local-openclaw");
    await expect(runtimeSelect).not.toContainText("No configured runtime");
    await expect(page.getByPlaceholder("https://github.com/org/repo")).toHaveCount(0);
  });
});
