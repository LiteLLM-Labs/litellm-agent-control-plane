/**
 * GET /api/v1/managed_agents/sessions/[session_id]/log
 *
 * Returns a human-friendly event timeline for a session, derived from the
 * durable SessionMessage log (see src/server/sessionStore.ts): creation, every
 * recorded turn, inferred sandbox recoveries, and a terminal marker. Powers
 * the "Session Log" side panel. Unlike /messages (which proxies the live
 * harness thread) this reads only the DB, so it works for dead/expired
 * sessions too.
 */

import { assertAuth } from "@/server/auth";
import { getSessionLog } from "@/server/sessionStore";
import { HttpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;
    const events = await getSessionLog(session_id);
    return Response.json(events);
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
