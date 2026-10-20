import { expect, test, type Page } from "@playwright/test";

const initialTitle = "Exclude inactive accounts from cross-account totals";
const initialSummary =
  "The reporting service includes inactive accounts by default. Explicitly exclude them when calculating totals.";
const stepLabels = [
  "Define scope",
  "Capture a memo",
  "Review & reuse",
  "Learn & curate",
];
const stepTitles = [
  "Define what agents should remember",
  "Turn a hard-won finding into a memo",
  "Review corrections. Share the better answer.",
  "Let outcomes improve the knowledge base",
];

async function goToStep(page: Page, step: number) {
  const button = page
    .getByRole("navigation", { name: "Demo steps" })
    .getByRole("button", { name: new RegExp(stepLabels[step - 1]) });
  await button.click();
  await expect(button).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("heading", { name: stepTitles[step - 1] })).toBeVisible();
}

test.describe("Shared knowledge demo", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/knowledge-demo/");
  });

  test("should render the product shell and distinguish user and operator categories", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Shared knowledge", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Demo steps" }).getByRole("button")).toHaveCount(4);
    await expect(page.getByRole("switch", { name: "Enable Account reporting" })).toBeChecked();
    await expect(page.getByText("User systems", { exact: true })).toBeVisible();
    await expect(page.getByText("Operator systems", { exact: true })).toBeVisible();
    await expect(page.getByText("4 enabled", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Bazel & builds 9 memos" }).click();
    await expect(page.getByRole("heading", { name: "Bazel & builds", exact: true })).toBeVisible();
    await expect(page.getByText("Build failures, caches, and dependency recovery", { exact: true })).toBeVisible();
  });

  test("should prevent saving a memo when its category is disabled", async ({ page }) => {
    await page.getByRole("switch", { name: "Enable Account reporting" }).uncheck();
    await expect(page.getByText("3 enabled", { exact: true })).toBeVisible();
    await goToStep(page, 2);

    await expect(page.getByRole("main").getByRole("alert")).toHaveText("Enable Account reporting in step 1 to save this memo.");
    await expect(page.getByRole("button", { name: "Save Memo to Shared Knowledge" })).toBeDisabled();

    await goToStep(page, 1);
    await page.getByRole("switch", { name: "Enable Account reporting" }).check();
    await goToStep(page, 2);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save Memo to Shared Knowledge" })).toBeEnabled();
  });

  test("should preserve edited memo content through saving and step navigation", async ({ page }) => {
    const title = "Use active child accounts in reporting totals";
    const summary = "Exclude inactive parents and children before summing reporting totals.";
    await goToStep(page, 2);
    await page.getByRole("textbox", { name: "Title", exact: true }).fill(" ");
    await expect(page.getByRole("button", { name: "Save Memo to Shared Knowledge" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
    await page.getByRole("textbox", { name: "Summary", exact: true }).fill("");
    await expect(page.getByRole("button", { name: "Save Memo to Shared Knowledge" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Summary", exact: true }).fill(summary);
    await page.getByRole("button", { name: "Save Memo to Shared Knowledge" }).click();
    await expect(page.getByRole("heading", { name: "Published memo", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();

    await goToStep(page, 3);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await goToStep(page, 4);
    await expect(page.getByRole("row").filter({ hasText: title })).toContainText("Promote to skill");
    await goToStep(page, 2);
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(title);
    await expect(page.getByRole("textbox", { name: "Summary", exact: true })).toHaveValue(summary);
    await expect(page.getByRole("button", { name: "Memo Saved · Available to Other Agents" })).toBeDisabled();
  });

  test("should keep an unsaved draft separate from the published sample until saved", async ({ page }) => {
    const draftTitle = "Unsaved active-account investigation";
    await goToStep(page, 2);
    await page.getByRole("textbox", { name: "Title", exact: true }).fill(draftTitle);

    await goToStep(page, 3);
    await expect(page.getByText(draftTitle, { exact: true })).toHaveCount(0);
    await expect(page.getByText("Using a published sample memo. Save your draft in step 2 to use it here.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: initialTitle, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Load v1 into Session" })).toBeEnabled();
    await page.getByRole("button", { name: "Run Judge Review" }).click();
    await page.getByRole("button", { name: "Load v2 into Session" }).click();
    await page.getByRole("button", { name: "Record Helpful Outcome" }).click();
    await goToStep(page, 4);
    await expect(page.getByText(draftTitle, { exact: true })).toHaveCount(0);
    await expect(page.getByText("Using a published sample memo. Save your draft in step 2 to use it here.", { exact: true })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: initialTitle })).toBeVisible();
    await page.getByRole("button", { name: "Run Periodic Review" }).click();

    await goToStep(page, 2);
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(draftTitle);
    await page.getByRole("button", { name: "Save Memo to Shared Knowledge" }).click();
    await goToStep(page, 3);
    await expect(page.getByRole("heading", { name: draftTitle, exact: true })).toBeVisible();
    await expect(page.getByText("Using a published sample memo. Save your draft in step 2 to use it here.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Load v1 into Session" })).toBeEnabled();
    await goToStep(page, 4);
    await expect(page.getByRole("row").filter({ hasText: draftTitle })).toContainText("28 helpful / 30 known");
    await expect(page.getByRole("button", { name: "Run Periodic Review" })).toBeEnabled();
  });

  test("should publish an evidence-backed correction and make its new version available", async ({ page }) => {
    await goToStep(page, 3);
    await expect(page.getByRole("button", { name: "Load v1 into Session" })).toBeVisible();
    await page.getByRole("button", { name: "Run Judge Review" }).click();

    await expect(page.getByText("Accepted · v2 published", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Load v2 into Session" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Run Judge Review" })).toBeDisabled();
    await expect(page.getByText("Version history retained · v1 → v2 (current)", { exact: true })).toBeVisible();
  });

  test("should reject an unsupported correction and keep the published version available", async ({ page }) => {
    await goToStep(page, 3);
    await page.getByRole("button", { name: "Try Unsupported Update" }).click();
    await page.getByRole("button", { name: "Run Judge Review" }).click();

    await expect(page.getByText("Rejected · v1 remains published", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Load v1 into Session" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Load v2 into Session" })).toHaveCount(0);
  });

  test("should retain published v2 when a later correction is pending or rejected", async ({ page }) => {
    await goToStep(page, 3);
    await page.getByRole("button", { name: "Run Judge Review" }).click();
    await expect(page.getByRole("button", { name: "Load v2 into Session" })).toBeVisible();
    await page.getByRole("button", { name: "Try Unsupported Update" }).click();
    await expect(page.getByRole("button", { name: "Load v2 into Session" })).toBeEnabled();
    await page.getByRole("button", { name: "Run Judge Review" }).click();
    await expect(page.getByText("Rejected · v2 remains published", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Load v2 into Session" })).toBeEnabled();
  });

  test("should prevent publishing the same supported correction more than once", async ({ page }) => {
    await goToStep(page, 3);
    await page.getByRole("button", { name: "Run Judge Review" }).click();
    await expect(page.getByText("Accepted · v2 published", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Evidence-backed Update" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Run Judge Review" })).toBeDisabled();

    await page.getByRole("button", { name: "Try Unsupported Update" }).click();
    await page.getByRole("button", { name: "Run Judge Review" }).click();
    await expect(page.getByRole("button", { name: "Evidence-backed Update" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Load v2 into Session" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Load v3 into Session" })).toHaveCount(0);
  });

  test("should record an outcome only after loading and include it in usefulness totals", async ({ page }) => {
    await goToStep(page, 3);
    await expect(page.getByRole("button", { name: "Record Helpful Outcome" })).toHaveCount(0);
    await page.getByRole("button", { name: "Run Judge Review" }).click();
    await page.getByRole("button", { name: "Load v2 into Session" }).click();
    await expect(page.getByText("Finance assistant loaded v2 into a different user’s session", { exact: true })).toBeVisible();

    await goToStep(page, 4);
    const memoRow = page.getByRole("row").filter({ hasText: initialTitle });
    await expect(memoRow).toContainText("28 helpful / 30 known");
    await expect(memoRow).toContainText("33 loads · 8 agents");
    await expect(page.getByText("Unknown", { exact: true }).locator("..").getByText("3", { exact: true })).toBeVisible();

    await goToStep(page, 3);
    await page.getByRole("button", { name: "Record Helpful Outcome" }).click();
    await expect(page.getByText("Helpful outcome recorded · linked to this memo version", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Outcome Recorded" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "v2 Loaded" })).toBeDisabled();

    await goToStep(page, 4);
    await expect(memoRow).toContainText("29 helpful / 31 known");
    await expect(memoRow).toContainText("33 loads · 8 agents");
    await expect(page.getByText("Unknown", { exact: true }).locator("..").getByText("2", { exact: true })).toBeVisible();
  });

  test("should retain recorded outcomes after another search or correction review", async ({ page }) => {
    await goToStep(page, 3);
    await page.getByRole("button", { name: "Load v1 into Session" }).click();
    await page.getByRole("button", { name: "Record Helpful Outcome" }).click();
    await page.getByRole("textbox", { name: "Search shared knowledge" }).fill("inactive accounts");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "Try Unsupported Update" }).click();
    await page.getByRole("button", { name: "Run Judge Review" }).click();
    await goToStep(page, 4);

    const memoRow = page.getByRole("row").filter({ hasText: initialTitle });
    await expect(memoRow).toContainText("29 helpful / 31 known");
    await expect(memoRow).toContainText("33 loads · 8 agents");
    await expect(page.getByText("Unknown", { exact: true }).locator("..").getByText("2", { exact: true })).toBeVisible();
  });

  test("should show an empty search result and recover with a relevant search", async ({ page }) => {
    await goToStep(page, 3);
    await page.getByRole("textbox", { name: "Search shared knowledge" }).fill("unrelated quantum penguins");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText("No matching demo memos", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Load v\d into Session/ })).toHaveCount(0);

    await page.getByRole("textbox", { name: "Search shared knowledge" }).fill("inactive accounts");
    await page.getByRole("textbox", { name: "Search shared knowledge" }).press("Enter");
    await expect(page.getByText("No matching demo memos", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Load v1 into Session" })).toBeVisible();
  });

  test("should promote frequent helpful guidance, archive obsolete guidance, and retain rare useful fixes", async ({ page }) => {
    await goToStep(page, 4);
    const promoted = page.getByRole("row").filter({ hasText: initialTitle });
    const archived = page.getByRole("row").filter({ hasText: "Legacy account-total workaround" });
    const retained = page.getByRole("row").filter({ hasText: "Bazel: recover from a corrupted JAR" });
    await expect(promoted).toContainText("Promote to skill");
    await expect(archived.getByText("Archive", { exact: true })).toBeVisible();
    await expect(retained.getByText("Keep", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Run Periodic Review" }).click();

    await expect(promoted).toContainText("Promoted to skill");
    await expect(archived.getByText("Archived", { exact: true })).toBeVisible();
    await expect(retained.getByText("Retained", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review Applied" })).toBeDisabled();
    await page.getByRole("button", { name: "View Skill" }).click();
    await expect(page.getByRole("dialog", { name: "Account reporting checks" })).toContainText("Promoted in demo");
    await expect(page.getByRole("dialog", { name: "Account reporting checks" })).toContainText("Derived from memo_014 · v1");
    await page.getByRole("button", { name: "Close Skill" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("should preserve the promoted skill version when its source memo later changes", async ({ page }) => {
    await goToStep(page, 4);
    await page.getByRole("button", { name: "Run Periodic Review" }).click();
    await page.getByRole("button", { name: "View Skill" }).click();
    const skillDialog = page.getByRole("dialog", { name: "Account reporting checks" });
    await expect(skillDialog).toContainText("Derived from memo_014 · v1");
    await page.getByRole("button", { name: "Close Skill" }).click();

    await goToStep(page, 3);
    await page.getByRole("button", { name: "Run Judge Review" }).click();
    await expect(page.getByRole("button", { name: "Load v2 into Session" })).toBeVisible();
    await goToStep(page, 4);
    await expect(page.getByText("Source: memo_014 · v1", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "View Skill" }).click();
    await expect(skillDialog).toContainText("Derived from memo_014 · v1");
    await expect(skillDialog).toContainText("Explicitly exclude inactive accounts from the total.");
    await expect(skillDialog).not.toContainText("Exclude inactive parent and child accounts before aggregation.");
  });

  test("should reset category, memo, version, outcome, search, and review state", async ({ page }) => {
    await page.getByRole("switch", { name: "Enable Billing" }).uncheck();
    await goToStep(page, 2);
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Edited reporting memo");
    await page.getByRole("textbox", { name: "Summary", exact: true }).fill("Edited summary");
    await page.getByRole("button", { name: "Save Memo to Shared Knowledge" }).click();
    await goToStep(page, 3);
    await page.getByRole("button", { name: "Run Judge Review" }).click();
    await page.getByRole("button", { name: "Load v2 into Session" }).click();
    await page.getByRole("button", { name: "Record Helpful Outcome" }).click();
    await page.getByRole("textbox", { name: "Search shared knowledge" }).fill("edited query");
    await goToStep(page, 4);
    await page.getByRole("button", { name: "Run Periodic Review" }).click();
    await page.getByRole("button", { name: "Reset Demo" }).click();

    await expect(page).toHaveURL(/#step-1$/);
    await expect(page.getByText("4 enabled", { exact: true })).toBeVisible();
    await goToStep(page, 2);
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(initialTitle);
    await expect(page.getByRole("textbox", { name: "Summary", exact: true })).toHaveValue(initialSummary);
    await expect(page.getByRole("button", { name: "Save Memo to Shared Knowledge" })).toBeEnabled();
    await goToStep(page, 3);
    await expect(page.getByText("Awaiting review", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Search shared knowledge" })).toHaveValue("cross-account totals include inactive accounts");
    await expect(page.getByRole("button", { name: "Load v1 into Session" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Outcome Recorded" })).toHaveCount(0);
    await goToStep(page, 4);
    await expect(page.getByRole("button", { name: "Run Periodic Review" })).toBeEnabled();
    await expect(page.getByRole("row").filter({ hasText: initialTitle })).toContainText("28 helpful / 30 known");
  });
});

for (const step of [1, 2, 3, 4]) {
  test(`should open step ${step} directly from its hash`, async ({ page }) => {
    await page.goto(`/knowledge-demo/#step-${step}`);
    await expect(page.getByRole("heading", { name: stepTitles[step - 1] })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Demo steps" }).getByRole("button", { name: new RegExp(stepLabels[step - 1]) })).toHaveAttribute("aria-current", "step");
  });
}

test("should fall back to the first step for an invalid hash", async ({ page }) => {
  await page.goto("/knowledge-demo/#step-99");
  await expect(page.getByRole("heading", { name: stepTitles[0] })).toBeVisible();
});

test("should honor a persisted dark theme with usable controls", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  await page.addInitScript(() => window.localStorage.setItem("theme", "dark"));
  await page.goto("/knowledge-demo/");
  await expect(page.locator("html")).toHaveClass(/dark/);

  const categorySwitch = page.getByRole("switch", { name: "Enable Account reporting" });
  await expect(categorySwitch).toBeVisible();
  await expect.poll(async () => (await categorySwitch.boundingBox())?.width ?? 0).toBeGreaterThan(20);
  await categorySwitch.uncheck();
  await expect(categorySwitch).not.toBeChecked();
  await categorySwitch.check();
  await goToStep(page, 2);
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Reporting checks in dark mode");
  await page.getByRole("button", { name: "Save Memo to Shared Knowledge" }).click();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
  await goToStep(page, 3);
  await expect(page.getByRole("heading", { name: "Reporting checks in dark mode", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run Judge Review" }).click();
  await expect(page.getByText("Accepted · v2 published", { exact: true })).toBeVisible();
  expect(hydrationErrors).toEqual([]);
});

test("should complete the demo without backend or API requests", async ({ page }) => {
  const backendRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    const isDataRequest = ["fetch", "xhr"].includes(request.resourceType());
    const isFrameworkRequest = url.pathname.startsWith("/_next/") || url.pathname.startsWith("/__nextjs");
    if (isDataRequest && !isFrameworkRequest) {
      backendRequests.push(`${request.method()} ${url.pathname}`);
    }
  });
  await page.goto("/knowledge-demo/");
  await goToStep(page, 2);
  await page.getByRole("button", { name: "Save Memo to Shared Knowledge" }).click();
  await page.getByRole("button", { name: "View Source Evidence" }).click();
  await expect(page.getByRole("dialog")).toContainText("Synthetic evidence for the prototype");
  await page.getByRole("button", { name: "Close Evidence" }).click();
  await goToStep(page, 3);
  await page.getByRole("button", { name: "Run Judge Review" }).click();
  await page.getByRole("button", { name: "Load v2 into Session" }).click();
  await page.getByRole("button", { name: "Record Helpful Outcome" }).click();
  await goToStep(page, 4);
  await page.getByRole("button", { name: "Run Periodic Review" }).click();
  expect(backendRequests).toEqual([]);
});
