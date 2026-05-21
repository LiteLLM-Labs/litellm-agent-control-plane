/**
 * ALL /api/v1/managed_agents/sessions/[session_id]/opencode/[...path]
 *
 * The single backend surface for talking to a session's agent. LAP exposes
 * the pod's opencode server VERBATIM under this per-session base, so the
 * official `@opencode-ai/sdk` (which has opencode's paths hardcoded —
 * `/event`, `/session/:id/message`, …) can be pointed straight at it:
 *
 *   createOpencodeClient({ baseUrl: "…/sessions/:id/opencode" })
 *
 * This replaces the hand-rolled /stream, /message_stream, /events, /message,
 * and /messages routes. LAP keeps doing the only things opencode can't: auth
 * (master-key bearer) and resolving the session → its pod `sandbox_url`. The
 * pod is only reachable from inside the cluster, so the harness needs no
 * additional auth header here (matches the existing harness client).
 *
 * SSE (`GET …/opencode/event`) and JSON (message send / history) both stream
 * through untouched — opencode's wire format IS the contract. The browser can
 * not attach a bearer to its requests, so it goes through the cookie-authed
 * shim at /api/ui/sessions/:id/opencode/[...path], which forwards here.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { getCachedSession, type SessionCacheEntry } from "@/server/sessionCache";
import { HttpError, httpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string; path?: string[] }>;
}

// The SDK can subscribe / send right after createSession, while the pod is
// still pulling images and starting the harness. Wait for `ready` before
// forwarding, matching the old /stream route's behavior.
const READY_WAIT_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 1_000;

/**
 * Resolve the session to its ready cache entry, polling until the pod comes
 * up. Fails fast on terminal states (404 missing, 410 failed/dead) and on the
 * 60s ceiling (504).
 */
async function resolveReady(
  session_id: string,
  signal: AbortSignal,
): Promise<SessionCacheEntry> {
  const deadline = Date.now() + READY_WAIT_TIMEOUT_MS;
  for (;;) {
    const cached = await getCachedSession(session_id);
    if (cached) return cached;
    const row = await prisma.session.findUnique({
      where: { session_id },
      select: { status: true },
    });
    if (!row) httpError(404, `session ${session_id} not found`);
    if (row.status === "failed" || row.status === "dead") {
      httpError(410, `session ${session_id} is ${row.status}`);
    }
    if (signal.aborted) httpError(503, "client disconnected");
    if (Date.now() >= deadline) {
      httpError(504, `session ${session_id} not ready within 60s`);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
}

async function proxy(req: Request, ctx: RouteContext): Promise<Response> {
  try {
    assertAuth(req);
    const { session_id, path } = await ctx.params;
    const tail = (path ?? []).join("/");
    const search = new URL(req.url).search;

    // Tie the upstream connection to the client's. EventSource / fetch-stream
    // closes on unload; Next forwards that as req.signal abort. Without this,
    // the pod-side SSE stays open until the harness keepalive ceiling.
    const upstreamCtl = new AbortController();
    req.signal.addEventListener("abort", () => upstreamCtl.abort(), {
      once: true,
    });

    const cached = await resolveReady(session_id, req.signal);
    const target = `${cached.sandbox_url}/${tail}${search}`;

    const headers: Record<string, string> = {
      "content-type": req.headers.get("content-type") ?? "application/json",
      accept: req.headers.get("accept") ?? "*/*",
    };
    const init: RequestInit = {
      method: req.method,
      headers,
      signal: upstreamCtl.signal,
      cache: "no-store",
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Buffer the body — opencode message payloads are small JSON (text +
      // optional base64 image parts), and buffering sidesteps undici's
      // half-duplex streaming-body constraints.
      init.body = await req.arrayBuffer();
    }

    const upstream = await fetch(target, init);

    const ct = upstream.headers.get("content-type") ?? "application/json";
    const outHeaders: Record<string, string> = { "content-type": ct };
    if (ct.includes("text/event-stream")) {
      outHeaders["cache-control"] = "no-cache, no-transform";
      outHeaders["connection"] = "keep-alive";
      // Disable proxy buffering on any nginx/Render edge that respects it.
      outHeaders["x-accel-buffering"] = "no";
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    console.error("opencode proxy error", e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
