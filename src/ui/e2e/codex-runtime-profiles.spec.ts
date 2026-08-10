import { expect, test, type Page } from "@playwright/test";

const harnesses = [
  {
    alias: "Codex-app-server",
    api_spec: "claude_managed_agents",
    display_name: "Codex-app-server",
    api_base: "https://codex.example.test",
    is_default: false,
    connected: true,
    masked_api_key: "rtk_...test",
    tools: [],
  },
  {
    alias: "chatgpt-profile",
    api_spec: "claude_managed_agents",
    display_name: "chatgpt-profile",
    api_base: "https://codex.example.test/profiles/chatgpt-profile",
    is_default: false,
    connected: true,
    masked_api_key: "rtk_...test",
    tools: [],
    codex_profile_type: "chatgpt",
    codex_controller_alias: "Codex-app-server",
  },
];

async function mockRuntimeApis(page: Page) {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("lite-harness-master-key", "sk-test");
  });
  await page.route("**/v1/models", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ data: [] }),
  }));
  await page.route("**/session", (route) => route.fulfill({
    contentType: "application/json",
    body: "[]",
  }));
  await page.route("**/api/inbox**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ items: [] }),
  }));
  await page.route("**/api/runtime-harnesses", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ harnesses }),
  }));
  await page.route("**/api/codex-connections/Codex-app-server", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ profiles: [{ alias: "chatgpt-profile", type: "chatgpt", model: "gpt-5.6-sol", ready: true }] }),
  }));
  await page.route("**/api/codex-connections/Codex-app-server/chatgpt-profile/account", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ account: null, requiresOpenaiAuth: true }),
  }));
  await page.route("https://raw.githubusercontent.com/**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ templates: [] }),
  }));
}

test("offers API, ChatGPT, and Remote SSH Codex connection forms", async ({ page }) => {
  await mockRuntimeApis(page);
  await page.goto("/runtimes/");
  await page.getByRole("button", { name: "New Runtime" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").first().click();
  await expect(page.getByText("Codex — OpenAI API", { exact: true })).toBeVisible();
  await expect(page.getByText("Codex — ChatGPT", { exact: true })).toBeVisible();
  await expect(page.getByText("Codex — Remote SSH", { exact: true })).toBeVisible();

  await page.getByText("Codex — ChatGPT", { exact: true }).click();
  await expect(dialog.getByText("Codex app-server controller")).toBeVisible();
  await expect(dialog.getByText("Sign in with ChatGPT", { exact: false })).toBeVisible();

  await dialog.getByRole("combobox").first().click();
  await page.getByText("Codex — Remote SSH", { exact: true }).click();
  await expect(dialog.getByText("Host or IP", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Private key", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Host key fingerprint (optional)", { exact: true })).toBeVisible();
});

test("shows native ChatGPT sign-in controls for a ChatGPT profile", async ({ page }) => {
  await mockRuntimeApis(page);
  await page.goto("/runtimes/");
  await page.getByText("chatgpt-profile", { exact: true }).first().click();
  await expect(page.getByText("ChatGPT sign-in required")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with ChatGPT" })).toBeVisible();
  await expect(page.getByText("no OpenAI API key is needed", { exact: false })).toBeVisible();
});
