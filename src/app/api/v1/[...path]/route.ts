/**
 * Catch-all passthrough to upstream LiteLLM.
 *
 * Anything under /api/v1/* that doesn't have a more specific handler (the
 * managed-agents routes are all explicit and win over this catch-all) gets
 * forwarded to ${LITELLM_API_BASE}/v1/<path> with the master key attached
 * server-side. Used by the UI for /v1/models and /v1/mcp/server.
 *
 * Auth: we still require the UI bearer on the way in, so the master key
 * never leaves the server unless the caller is already authenticated.
 */

import { assertAuth } from "@/server/auth";
import { env } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  // Upstream may set content-encoding: gzip, but undici has already
  // decompressed the body for us. Forwarding the header makes the browser
  // try to decode again → ERR_CONTENT_DECODING_FAILED.
  "content-encoding",
]);

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function forward(req: Request, ctx: RouteContext): Promise<Response> {
  try {
    assertAuth(req);
  } catch (r) {
    if (r instanceof Response) return r;
    throw r;
  }

  const { path } = await ctx.params;
  const base = env.LITELLM_API_BASE.replace(/\/+$/, "");
  const url = new URL(req.url);
  const target = `${base}/v1/${path.join("/")}${url.search}`;

  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === "authorization") continue;
    headers.set(k, v);
  }
  headers.set("Authorization", `Bearer ${env.LITELLM_API_KEY}`);

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    return Response.json(
      { error: `upstream unreachable: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const respHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    respHeaders.set(k, v);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export async function GET(req: Request, ctx: RouteContext) {
  return forward(req, ctx);
}
export async function POST(req: Request, ctx: RouteContext) {
  return forward(req, ctx);
}
export async function PUT(req: Request, ctx: RouteContext) {
  return forward(req, ctx);
}
export async function PATCH(req: Request, ctx: RouteContext) {
  return forward(req, ctx);
}
export async function DELETE(req: Request, ctx: RouteContext) {
  return forward(req, ctx);
}
export async function OPTIONS(req: Request, ctx: RouteContext) {
  return forward(req, ctx);
}
