/**
 * Browser opencode client for a LAP session.
 *
 * Points `@opencode-ai/sdk` at LAP's cookie-authed UI shim
 * (/api/ui/sessions/:id/opencode), which forwards to the pod's opencode
 * server. The master key never reaches the browser — auth rides the HttpOnly
 * cookie installed at /login, sent automatically on these same-origin calls.
 *
 *   const oc = browserOpencodeClient(lapSessionId);
 *   await oc.session.prompt({ path: { id: harnessSessionId }, body: {...} });
 *   const events = await oc.event.subscribe();
 *   for await (const ev of events.stream) { ... }
 */

// Import the client-only entry — the package root re-exports server code
// (createOpencode → process.js, which needs fs/child_process) that can't bundle
// for the browser.
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";

export function browserOpencodeClient(lapSessionId: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl: `/api/ui/sessions/${encodeURIComponent(lapSessionId)}/opencode`,
    // credentials:"include" guarantees the HttpOnly auth cookie rides along
    // even if a future deploy splits the UI onto a different origin.
    fetch: (request) => fetch(new Request(request, { credentials: "include" })),
  });
}
