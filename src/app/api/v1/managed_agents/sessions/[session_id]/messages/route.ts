/**
 * GET /api/v1/managed_agents/sessions/[session_id]/messages
 *
 * Proxies opencode's `GET /session/:harness_session_id/message`. Returns the
 * full thread including the agent-loop intermediates (tool calls, reasoning
 * parts) that POST /message hides — the UI uses this as the source of truth
 * for rendering reasoning + tool blocks.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { harnessListMessages } from "@/server/harness";
import { HttpError, httpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;

    const row = await prisma.session.findUnique({ where: { session_id }, include: { agent: true } });
    if (!row) httpError(404, `session ${session_id} not found`);

    if (row.agent.harness_id === "claude-code-brain-inline") {
      // Brain-inline stores history directly — no harness to call
      if (Array.isArray(row.history) && row.history.length > 0) {
        return Response.json(row.history);
      }
      return Response.json([]);
    }

    if (!row.sandbox_url || !row.harness_session_id) {
      // Sessions still spinning up (creating, no harness session yet) and
      // dead/failed rows have nothing to fetch. Return [] so the UI can
      // show an empty thread without special-casing each status.
      return Response.json([]);
    }

    try {
      const msgs = await harnessListMessages({
        sandbox_url: row.sandbox_url,
        harness_session_id: row.harness_session_id,
      });
      // If the last harness message is a user message (the agent's response
      // hasn't been committed yet — either still in-flight or interrupted),
      // check whether we have a partial-turn snapshot from the stream route
      // and append it so the UI can show whatever work the agent produced
      // before the client disconnected or the turn was interrupted.
      const lastHarness = msgs[msgs.length - 1];
      const lastIsUser =
        !lastHarness || (lastHarness as { info?: { role?: string } }).info?.role === "user";
      if (lastIsUser && Array.isArray(row.pending_assistant_parts) && row.pending_assistant_parts.length > 0) {
        msgs.push({
          info: {
            id: `pending-${row.session_id}`,
            sessionID: row.harness_session_id,
            role: "assistant",
          },
          parts: row.pending_assistant_parts as { type: string; [k: string]: unknown }[],
        });
      }
      return Response.json(msgs);
    } catch (err) {
      console.error("harness list_messages failed, falling back to history", err);
      // Harness unreachable (pod recycled, dead session, local dev without
      // a live sandbox). Return the last-known history snapshot so dead /
      // expired sessions can still display their full thread in the UI.
      if (Array.isArray(row.history) && row.history.length > 0) {
        return Response.json(row.history);
      }
      throw new HttpError(502, "harness request failed");
    }
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
