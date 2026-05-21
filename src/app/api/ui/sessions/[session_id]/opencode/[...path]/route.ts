/**
 * ALL /api/ui/sessions/[session_id]/opencode/[...path]
 *
 * Cookie-authed browser shim in front of the v1 opencode proxy
 * (`/api/v1/managed_agents/sessions/:id/opencode/[...path]`). The web UI's
 * `@opencode-ai/sdk` client points its baseUrl here; the browser can't attach
 * an Authorization header (and must never hold the master key), so this route
 * gates on the HttpOnly cookie installed at /login and forwards upstream with
 * the server-side bearer.
 *
 * Same as the v1 proxy, SSE and JSON both stream through untouched. Mirrors
 * the auth + same-host self-call pattern of the legacy /stream shim.
 */

import { assertCookieAuth } from "@/server/auth";
import { env } from "@/server/env";
import { HttpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string; path?: string[] }>;
}

async function proxy(req: Request, ctx: RouteContext): Promise<Response> {
  try {
    assertCookieAuth(req);
    const { session_id, path } = await ctx.params;
    const tail = (path ?? []).join("/");
    const search = new URL(req.url).search;

    // The v1 route lives in this same Next app — talk to localhost, never the
    // public URL (Render/Cloudflare blocks the hairpin self-call). Split
    // deployments / local dev override via LAP_INTERNAL_URL.
    const explicit = (process.env.LAP_INTERNAL_URL || "").replace(/\/+$/, "");
    const port = process.env.PORT || "3000";
    const base = explicit || `http://127.0.0.1:${port}`;
    const target =
      `${base}/api/v1/managed_agents/sessions/` +
      `${encodeURIComponent(session_id)}/opencode/${tail}${search}`;

    const upstreamCtl = new AbortController();
    req.signal.addEventListener("abort", () => upstreamCtl.abort(), {
      once: true,
    });

    const headers: Record<string, string> = {
      authorization: `Bearer ${env.MASTER_KEY}`,
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
      init.body = await req.arrayBuffer();
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, init);
    } catch (err) {
      console.error("ui opencode upstream fetch failed", err);
      return Response.json({ error: "upstream unreachable" }, { status: 502 });
    }

    const ct = upstream.headers.get("content-type") ?? "application/json";
    const outHeaders: Record<string, string> = { "content-type": ct };
    if (ct.includes("text/event-stream")) {
      outHeaders["cache-control"] = "no-cache, no-transform";
      outHeaders["connection"] = "keep-alive";
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
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
