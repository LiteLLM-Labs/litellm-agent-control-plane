/**
 * E2E test: session restart preserves conversation history in the UI.
 *
 * Regression guard: after a restart, the session thread was blank even though
 * the platform claimed the conversation was preserved. This test catches that.
 *
 * Flow:
 * 1. Create a brain-inline session via API.
 * 2. Send a message via API and wait for a response (establishes history).
 * 3. Call POST /restart via API — this creates a fresh harness session and
 *    replays the saved history as the first message into the new session.
 * 4. Wait for the session to become ready again.
 * 5. Navigate to the session URL in the browser.
 * 6. Assert the thread is NOT blank — prior messages must be visible.
 *    The placeholder "Sandbox is ready. Send a message below." must NOT be the
 *    only content; at least one message bubble must be present.
 *
 * Requires:
 *   BASE_URL  — fallback: the known EKS ALB
 *   MASTER_KEY — required; no fallback
 */

import { test, expect } from "@playwright/test";

const BASE_URL =
  process.env.BASE_URL ??
  "http://ae7fbba6b9bd94fb8ae7aa4640d70da1-1735666001.us-east-1.elb.amazonaws.com";

// CI must inject MASTER_KEY — no hardcoded fallback.
const MASTER_KEY = process.env.MASTER_KEY;
if (!MASTER_KEY) throw new Error("MASTER_KEY env var is required");

// brain-inline agent used across inline-harness tests.
const AGENT_WITH_PROJECTS_ID = "6b023d93-b570-4a60-a5bd-6a0b630e4a7b";

// Timeouts — inline harness can take 10-30 s per turn.
const SESSION_READY_TIMEOUT_MS = 30_000;
const MESSAGE_TIMEOUT_MS = 60_000;
const RESTART_TIMEOUT_MS = 30_000;
const PAGE_LOAD_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Minimal API helpers (duplicated from inline-harness-tools.spec.ts / agent-linear-fix.spec.ts
// because Playwright does not support shared helper imports across spec files).
// ---------------------------------------------------------------------------

async function apiPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/api/v1/managed_agents/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MASTER_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function apiGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/api/v1/managed_agents/${path}`, {
    headers: { Authorization: `Bearer ${MASTER_KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function waitForReady(sessionId: string, timeoutMs = SESSION_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await apiGet(`sessions/${sessionId}`);
    if (session.status === "ready") return;
    if (session.status === "failed") {
      throw new Error(`session failed: String(session.failure_reason)`);
    }
    await new Promise<void>((r) => setTimeout(r, 2_000));
  }
  throw new Error(`session ${sessionId} never became ready within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("session restart — conversation history preserved in UI", () => {
  let sessionId: string;
  // The text we send so we can assert it appears in the thread after restart.
  const PROBE_MESSAGE = "Reply with exactly: history-probe-acknowledged";

  test.beforeAll(async () => {
    // 1. Create a brain-inline session.
    const session = await apiPost(`agents/${AGENT_WITH_PROJECTS_ID}/session`, {
      title: "e2e restart history",
    });
    sessionId = session.id as string;
    if (!sessionId) throw new Error("session create returned no id");

    // 2. Wait for the session to become ready.
    await waitForReady(sessionId, SESSION_READY_TIMEOUT_MS);

    // 3. Send a message to establish history in the session.
    //    We use a short, deterministic probe message so it's easy to assert
    //    that it appears in the thread after restart.
    const msgRes = await fetch(
      `${BASE_URL}/api/v1/managed_agents/sessions/${sessionId}/message`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MASTER_KEY}`,
        },
        body: JSON.stringify({ text: PROBE_MESSAGE }),
        // fetch itself doesn't accept a per-request timeout, but the jest/
        // playwright test timeout (MESSAGE_TIMEOUT_MS below) bounds the outer call.
      },
    );
    if (!msgRes.ok) {
      throw new Error(`message send failed: ${msgRes.status}: ${await msgRes.text()}`);
    }
    // Drain the response body (required even if we don't inspect it so the
    // connection closes cleanly before the restart POST below).
    await msgRes.json();

    // 4. Restart the session via API. For brain-inline this is synchronous:
    //    the route flips the session to ready and replays history as the first
    //    harness message before returning 200.
    const restartRes = await fetch(
      `${BASE_URL}/api/v1/managed_agents/sessions/${sessionId}/restart`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MASTER_KEY}`,
        },
      },
    );
    if (!restartRes.ok) {
      throw new Error(`restart failed: ${restartRes.status}: ${await restartRes.text()}`);
    }
    await restartRes.json();

    // 5. Confirm the session is ready post-restart (brain-inline returns ready
    //    immediately; K8s harnesses may need another poll cycle).
    await waitForReady(sessionId, RESTART_TIMEOUT_MS);
  }, MESSAGE_TIMEOUT_MS + RESTART_TIMEOUT_MS + SESSION_READY_TIMEOUT_MS + 10_000);

  // -------------------------------------------------------------------------
  // Browser test: navigate to the session URL and verify thread is not blank.
  // -------------------------------------------------------------------------

  test("thread shows prior messages after restart — not blank", async ({ page }) => {
    // Inject the master key into localStorage so the UI authenticates without
    // an interactive login flow. This mirrors the pattern in session-navigation-
    // persistence.spec.ts.
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await page.evaluate((key) => {
      localStorage.setItem("ui_master_key", key);
    }, MASTER_KEY as string);

    // Navigate to the session page.
    await page.goto(`${BASE_URL}/sessions/${sessionId}`, { waitUntil: "domcontentloaded" });

    // Wait for the page to load and the session status to show "ready".
    // The header renders a small status badge with the session status label.
    await expect(
      page.locator("text=ready").first(),
    ).toBeVisible({ timeout: PAGE_LOAD_TIMEOUT_MS });

    // Allow the thread to hydrate from the harness (SDK stream seeds the
    // messages list from the saved history).
    // We wait up to 15 s — that covers the initial API round-trip plus any
    // SSE event stream seeding that the opencode SDK performs.
    const THREAD_HYDRATION_TIMEOUT_MS = 15_000;

    // Primary assertion: the probe message we sent before the restart must be
    // visible in the thread. This is the exact regression check — after restart
    // the UI was showing a blank thread even though history was replayed.
    //
    // The probe message text ("history-probe-acknowledged") is unique enough
    // that a match means real harness content is rendered.
    await expect(
      page.getByText("history-probe-acknowledged", { exact: false }),
    ).toBeVisible({ timeout: THREAD_HYDRATION_TIMEOUT_MS });

    // Secondary assertion: the empty-thread placeholder must NOT be the only
    // visible content. If messages are present the placeholder is not rendered
    // (the view conditionally shows it only when messages.length === 0 and
    // status === "ready").
    const emptyPlaceholder = page.getByText("Send a message below.", { exact: false });
    // It's fine for the placeholder to be absent entirely; we just must not
    // be in the blank-thread state after a restart that had prior history.
    const placeholderVisible = await emptyPlaceholder.isVisible();
    if (placeholderVisible) {
      // If the placeholder is visible, probe content must ALSO be visible
      // (thread rendered messages + placeholder can coexist depending on the
      // exact render path). In the regression case the placeholder is the
      // ONLY thing shown — no message bubbles at all. The `getByText` assertion
      // above already guards against that; this explicit fail makes the reason
      // obvious in CI output.
      throw new Error(
        "Regression detected: UI shows empty-thread placeholder after restart — prior conversation not visible.",
      );
    }

    // Tertiary assertion: at least one message bubble element is present in the
    // DOM. Message bubbles are rendered inside the thread scroll container.
    // User prompt bubbles use a characteristic bg-muted/30 border-border class
    // that we can target with a partial class selector; alternatively we match
    // the known text from our probe send.
    //
    // We use a broad selector that matches the UserPromptBlock wrapper so the
    // test doesn't break if CSS class names change — the text content assertion
    // above is the primary guard.
    const messageCount = await page
      .locator("[class*='bg-muted'][class*='border'][class*='rounded']")
      .count();
    expect(
      messageCount,
      "Expected at least one message bubble in the thread after restart",
    ).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Companion API test: session row reflects ready state after restart.
  // -------------------------------------------------------------------------

  test("session status is ready and harness_session_id is set after restart", async () => {
    const session = await apiGet(`sessions/${sessionId}`);
    expect(session.status).toBe("ready");
    expect(session.harness_session_id).toBeTruthy();
  });
});
