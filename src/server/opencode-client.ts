/**
 * Server-side opencode client for a LAP session.
 *
 * Used by integration dispatchers (Slack, Linear) that run inside the LAP
 * process. Points `@opencode-ai/sdk` at the v1 opencode proxy with the
 * master-key bearer, talking to localhost (never the public URL — Render /
 * Cloudflare block the hairpin self-call). Split deploys / local dev override
 * the host via LAP_INTERNAL_URL.
 */

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";

import { env } from "@/server/env";

export function serverOpencodeClient(lapSessionId: string): OpencodeClient {
  const explicit = (process.env.LAP_INTERNAL_URL || "").replace(/\/+$/, "");
  const base = explicit || `http://127.0.0.1:${process.env.PORT || "3000"}`;
  return createOpencodeClient({
    baseUrl: `${base}/api/v1/managed_agents/sessions/${encodeURIComponent(
      lapSessionId,
    )}/opencode`,
    fetch: (request) => {
      request.headers.set("authorization", `Bearer ${env.MASTER_KEY}`);
      return fetch(request);
    },
  });
}
