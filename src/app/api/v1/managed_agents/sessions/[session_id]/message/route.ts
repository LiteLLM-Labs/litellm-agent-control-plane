/**
 * POST /api/v1/managed_agents/sessions/[session_id]/message
 *
 * Forwards a user message to the per-session opencode harness. The session
 * must be `ready` and have both a `sandbox_url` and a `harness_session_id` —
 * any other state means the Fargate task isn't fully wired yet, so we 4xx
 * instead of attempting the call.
 *
 * The harness reply is returned verbatim (the frontend already understands
 * its shape via `HarnessMessageResponse`). We bump `last_seen_at` after the
 * round-trip so reconcile/idle GC can see the session is live; the extra
 * tens of millis is dwarfed by the harness call itself.
 *
 * Network or 5xx errors from the harness bubble up as a 502 via the generic
 * error handler. Marking the session dead on connection-refused is a v2
 * concern — for now the reconciler will eventually catch it.
 */

import { ZodError } from "zod";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { expandMessage, harnessSendMessage } from "@/server/harness";
import {
  HttpError,
  httpError,
  SendMessageBody,
  type HarnessMessagePart,
} from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

export async function POST(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;
    const body = SendMessageBody.parse(await req.json());

    const row = await prisma.session.findUnique({
      where: { session_id },
      include: { agent: true },
    });
    if (!row || row.status !== "ready") {
      httpError(404, `session ${session_id} not found or not ready`);
    }
    if (!row.sandbox_url || !row.harness_session_id) {
      httpError(409, `session ${session_id} is not fully provisioned`);
    }

    // The zod schema accepts arbitrary `Record<string, unknown>` parts to
    // stay drop-in compatible with the Python harness wire format; the
    // harness itself validates the `type` discriminator, so we trust the
    // shape here and cast to the runtime contract.
    const parts = expandMessage(
      body.text,
      body.parts as HarnessMessagePart[] | undefined,
    );

    let response;
    try {
      response = await harnessSendMessage({
        sandbox_url: row.sandbox_url,
        harness_session_id: row.harness_session_id,
        model: row.agent.model,
        parts,
      });
    } catch (err) {
      // Network failure or 5xx from the sandbox. Re-throw as a 502 so the
      // caller can distinguish "harness unreachable" from a generic 500.
      console.error("harness send_message failed", err);
      throw new HttpError(502, "harness request failed");
    }

    await prisma.session.update({
      where: { session_id },
      data: { last_seen_at: new Date() },
    });

    return Response.json(response);
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    if (e instanceof ZodError)
      return Response.json({ error: e.issues }, { status: 400 });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
