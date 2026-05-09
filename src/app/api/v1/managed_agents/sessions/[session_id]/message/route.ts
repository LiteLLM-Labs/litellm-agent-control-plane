/**
 * POST /api/v1/managed_agents/sessions/[session_id]/message
 *
 * Forwards a user message to the per-session opencode harness. The session
 * must be `ready` and have both a `sandbox_url` and a `harness_session_id` —
 * any other state means the Fargate task isn't fully wired yet, so we 4xx
 * instead of attempting the call.
 *
 * The harness reply is returned verbatim (the frontend already understands
 * its shape via `HarnessMessageResponse`). The `last_seen_at` bump and the
 * full-thread history snapshot both run fire-and-forget after the response
 * has been queued back to the client, so the cross-region DB round-trip
 * (Render Oregon ↔ Postgres) doesn't sit on the user-facing critical path.
 * A best-effort drop on either is fine — the reconciler's idle sweep will
 * catch a row whose last_seen_at fell behind by one user turn.
 *
 * Network or 5xx errors from the harness bubble up as a 502 via the generic
 * error handler. On hard connect failures (timeout, refused, DNS) we also
 * mark the session `dead` inline so the UI can surface restart immediately
 * instead of waiting up to RECONCILE_INTERVAL_SECONDS for the ghost sweep.
 */

import { ZodError } from "zod";

import type { Prisma } from "@prisma/client";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import {
  expandMessage,
  harnessListMessages,
  harnessSendMessage,
} from "@/server/harness";
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

// undici / Node net error codes that indicate the sandbox host is definitively
// unreachable — TCP-handshake or DNS-resolution failures, not mid-request
// errors. We deliberately exclude codes that fire on transient conditions
// (`ECONNRESET` from a brief container restart or load-balancer teardown,
// `UND_ERR_SOCKET` from a keepalive race) — those would permanently kill a
// recoverable session in <1s, which is worse than letting the reconciler
// catch it one tick later.
const HARD_CONNECT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function isHardConnectFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === "string" && HARD_CONNECT_CODES.has(e.code)) return true;
  const cause = e.cause;
  if (cause && typeof cause === "object") {
    const c = (cause as { code?: unknown }).code;
    if (typeof c === "string" && HARD_CONNECT_CODES.has(c)) return true;
  }
  return false;
}

async function persistHistorySnapshot(opts: {
  session_id: string;
  sandbox_url: string;
  harness_session_id: string;
}): Promise<void> {
  try {
    const msgs = await harnessListMessages({
      sandbox_url: opts.sandbox_url,
      harness_session_id: opts.harness_session_id,
    });
    await prisma.session.update({
      where: { session_id: opts.session_id },
      data: {
        history: msgs as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.warn(
      `history snapshot failed for session ${opts.session_id}:`,
      err,
    );
  }
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
      if (isHardConnectFailure(err)) {
        try {
          // updateMany so the status guard is part of the WHERE — avoids a
          // race with the reconciler flipping the row first.
          await prisma.session.updateMany({
            where: { session_id, status: "ready" },
            data: {
              status: "dead",
              failure_reason: "sandbox unreachable",
              stopped_at: new Date(),
            },
          });
        } catch (markErr) {
          console.warn(
            `failed to mark session ${session_id} dead after connect failure:`,
            markErr,
          );
        }
      }
      throw new HttpError(502, "harness request failed");
    }

    // Fire-and-forget: bump last_seen_at + snapshot the full opencode thread
    // into Session.history. Both are best-effort and run AFTER the response
    // is queued to the client — a cross-region DB write is ~5–50ms that we
    // don't need on the critical path. Failures are logged and swallowed;
    // the idle reconciler will catch a row whose timestamp drifted by one
    // user turn.
    void prisma.session
      .update({
        where: { session_id },
        data: { last_seen_at: new Date() },
      })
      .catch((err) => {
        console.warn(
          `failed to bump last_seen_at for session ${session_id}:`,
          err,
        );
      });
    void persistHistorySnapshot({
      session_id,
      sandbox_url: row.sandbox_url,
      harness_session_id: row.harness_session_id,
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
