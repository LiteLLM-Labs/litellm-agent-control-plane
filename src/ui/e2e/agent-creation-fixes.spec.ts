import { test, expect } from "@playwright/test";

const MASTER_KEY = process.env.E2E_MASTER_KEY ?? "";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login/");
  await page.fill('input[id="key"]', MASTER_KEY);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 10000 });
}

test.describe("Bug fix: session runtime events", () => {
  test("new harness session does not throw 500 on chat load", async ({ page }) => {
    const errors: string[] = [];

    page.on("response", (response) => {
      if (response.url().includes("/events") && response.status() >= 500) {
        errors.push(`${response.status()} ${response.url()}`);
      }
    });

    await login(page);
    await page.goto("/chat/");
    await page.waitForTimeout(3000);

    expect(errors).toHaveLength(0);
  });

  test("new session does not show runtime error in chat", async ({ page }) => {
    await login(page);
    await page.goto("/chat/");
    await page.waitForTimeout(2000);

    const errorText = await page.textContent("body");
    expect(errorText).not.toContain("invalid config: session is not a runtime session");
  });
});

test.describe("Bug fix: agent draft fallback notice", () => {
  test("agent creation page loads and shows prompt input", async ({ page }) => {
    await login(page);
    await page.goto("/agents/new/");
    await page.waitForLoadState("networkidle");

    const input = page.locator('textarea[placeholder="Describe your agent..."]');
    await expect(input).toBeVisible({ timeout: 10000 });
  });

  test("agent creation page loads without 401 errors", async ({ page }) => {
    const authErrors: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 401) {
        authErrors.push(response.url());
      }
    });

    await login(page);
    await page.goto("/agents/new/");
    await page.waitForLoadState("networkidle");

    expect(authErrors).toHaveLength(0);
  });
});
