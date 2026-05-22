/**
 * Durable conversation store — the single, harness-agnostic DB writer for a
 * session's message thread.
 *
 * Why this exists: `Session.history` is a single JSON blob overwritten,
 * fire-and-forget, *after* the harness reply. If the sandbox dies mid-turn the
 * user's in-flight message and the reply are never written and that turn is
 * lost. Here we persist the user turn *before* dialing the harness and the
 * assistant turn on reply, into an append-only table — so a dead sandbox can
 * be rehydrated without losing work.
 *
 * Only the platform backend can reach Postgres (the harness pods have no DB
 * credentials), so persistence happens here at the HTTP boundary and works
 * identically for every harness (opencode, claude-agent-sdk, …) — the harness
 * needs no writer of its own.
 */

import type { Prisma, PrismaClient, SessionMessage } from "@prisma/client";

import { prisma } from "@/server/db";
import { formatHistoryAsText } from "@/server/harness";
import type {
  HarnessMessage,
  HarnessMessagePart,
  HarnessMessageResponse,
} from "@/server/types";

export type SessionMessageRow = SessionMessage;

// Prisma transaction client (the `tx` handed to an interactive transaction).
type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

async function nextSeq(tx: Tx, session_id: string): Promise<number> {
  // Serialize concurrent inserts for the same session on a transaction-scoped
  // advisory lock, so two callers can't both read the same max(seq) and then
  // collide on the (session_id, seq) unique constraint (which would be caught,
  // logged, and silently drop the turn — defeating durability). The lock is
  // keyed on the session id and released automatically at commit/rollback;
  // because it lives in Postgres it serializes across web replicas too, not
  // just within one process. (A plain `SELECT MAX(seq) … FOR UPDATE` can't be
  // used here — Postgres rejects FOR UPDATE with aggregate functions.)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${session_id}))`;
  const last = await tx.sessionMessage.findFirst({
    where: { session_id },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return last ? last.seq + 1 : 0;
}

/**
 * Persist a user turn as `pending` *before* the harness call. The returned
 * `message_id` is handed to `completeAssistantMessage` once the reply lands.
 * A row left `pending` (harness never replied) is the durable evidence of an
 * interrupted turn — replay still surfaces it so the model sees the question.
 *
 * Best-effort: durability must never block the user's request, so a write
 * failure is logged and we return null rather than throwing.
 */
export async function appendUserMessage(opts: {
  session_id: string;
  harness_session_id: string | null;
  parts: HarnessMessagePart[];
}): Promise<{ message_id: string; seq: number } | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const seq = await nextSeq(tx as unknown as Tx, opts.session_id);
      const row = await tx.sessionMessage.create({
        data: {
          session_id: opts.session_id,
          harness_session_id: opts.harness_session_id,
          seq,
          role: "user",
          status: "pending",
          parts: opts.parts as unknown as Prisma.InputJsonValue,
        },
        select: { message_id: true, seq: true },
      });
      return row;
    });
  } catch (err) {
    console.warn(
      `appendUserMessage failed for session ${opts.session_id}:`,
      err,
    );
    return null;
  }
}

/**
 * Mark the user turn `complete` and append the assistant reply as a new
 * `complete` row. The harness `POST /message` reply only carries the final
 * assistant message — enough context for replay. Best-effort.
 */
export async function completeAssistantMessage(opts: {
  session_id: string;
  user_message_id: string | null;
  harness_session_id: string | null;
  response: HarnessMessageResponse;
}): Promise<void> {
  try {
    const parts = Array.isArray(opts.response.parts) ? opts.response.parts : [];
    await prisma.$transaction(async (tx) => {
      if (opts.user_message_id) {
        await tx.sessionMessage.update({
          where: { message_id: opts.user_message_id },
          data: { status: "complete", completed_at: new Date() },
        });
      }
      const seq = await nextSeq(tx as unknown as Tx, opts.session_id);
      await tx.sessionMessage.create({
        data: {
          session_id: opts.session_id,
          harness_session_id: opts.harness_session_id,
          seq,
          role: "assistant",
          status: "complete",
          parts: parts as unknown as Prisma.InputJsonValue,
          completed_at: new Date(),
        },
      });
    });
  } catch (err) {
    console.warn(
      `completeAssistantMessage failed for session ${opts.session_id}:`,
      err,
    );
  }
}

/**
 * Flag a user turn `failed` — the harness errored and we are not going to
 * recover this turn (e.g. a non-recoverable 4xx). Distinct from `pending`,
 * which we deliberately keep for crashed/interrupted turns so they replay.
 */
export async function markUserMessageFailed(
  message_id: string,
): Promise<void> {
  try {
    await prisma.sessionMessage.update({
      where: { message_id },
      data: { status: "failed", completed_at: new Date() },
    });
  } catch (err) {
    console.warn(`markUserMessageFailed failed for ${message_id}:`, err);
  }
}

/**
 * Ordered conversation for replay/rehydrate. Excludes `failed` rows; keeps
 * `pending` ones so an interrupted user turn is still shown to the model.
 */
export async function listSessionMessages(
  session_id: string,
): Promise<SessionMessageRow[]> {
  return prisma.sessionMessage.findMany({
    where: { session_id, status: { not: "failed" } },
    orderBy: { seq: "asc" },
  });
}

/**
 * Render the durable log into the `<previous_session_history>` text blob the
 * harness replays as the first message of a rehydrated session. Reuses
 * `formatHistoryAsText` so the wire shape matches the legacy history-blob path.
 */
export function formatSessionMessagesAsText(
  rows: SessionMessageRow[],
): string {
  const msgs: HarnessMessage[] = rows.map((r) => ({
    info: {
      id: r.message_id,
      sessionID: r.harness_session_id ?? "",
      role: r.role,
    },
    parts: (Array.isArray(r.parts) ? r.parts : []) as HarnessMessagePart[],
  }));
  return formatHistoryAsText(msgs);
}

// ---------------------------------------------------------------------------
// Session Log — a human-friendly event timeline derived from the durable log,
// powering the "Session Log" side panel in the UI.
// ---------------------------------------------------------------------------

export type SessionLogEventKind =
  | "created"
  | "user"
  | "assistant"
  | "recovered"
  | "ended";

export interface SessionLogEvent {
  id: string;
  kind: SessionLogEventKind;
  at: string; // ISO timestamp
  title: string;
  detail?: string;
  // For message events: pending | complete | failed.
  status?: string;
}

const PREVIEW_MAX = 240;

// Pull a short, human-readable preview out of a turn's parts. Prefers the last
// text part (for assistant turns that's the final answer, not the reasoning
// preamble); falls back to describing non-text content (images, tool calls).
function previewParts(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  let lastText: string | undefined;
  const kinds: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const type = (p as { type?: unknown }).type;
    if (typeof type === "string") kinds.push(type);
    const text = (p as { text?: unknown }).text;
    if (type === "text" && typeof text === "string" && text.trim()) {
      lastText = text.trim();
    }
  }
  if (lastText) {
    return lastText.length > PREVIEW_MAX
      ? `${lastText.slice(0, PREVIEW_MAX)}…`
      : lastText;
  }
  const unique = [...new Set(kinds)];
  return unique.length > 0 ? `[${unique.join(", ")}]` : undefined;
}

/**
 * Build the event timeline for a session: creation, every recorded turn, any
 * sandbox recoveries (inferred from a change in `harness_session_id` between
 * consecutive turns — that only happens when rehydrateSession brought up a
 * fresh sandbox), and a terminal "ended" marker for dead/failed sessions.
 */
export async function getSessionLog(
  session_id: string,
): Promise<SessionLogEvent[]> {
  const [session, rows] = await Promise.all([
    prisma.session.findUnique({
      where: { session_id },
      select: {
        created_at: true,
        status: true,
        stopped_at: true,
        failure_reason: true,
      },
    }),
    prisma.sessionMessage.findMany({
      where: { session_id },
      orderBy: { seq: "asc" },
    }),
  ]);
  if (!session) return [];

  const events: SessionLogEvent[] = [
    {
      id: `${session_id}:created`,
      kind: "created",
      at: session.created_at.toISOString(),
      title: "Session created",
    },
  ];

  let prevHarness: string | null = null;
  for (const r of rows) {
    if (
      r.harness_session_id &&
      prevHarness &&
      r.harness_session_id !== prevHarness
    ) {
      events.push({
        id: `${r.message_id}:recovered`,
        kind: "recovered",
        at: r.created_at.toISOString(),
        title: "Sandbox recovered",
        detail:
          "The previous sandbox ended; the conversation was replayed into a fresh one.",
      });
    }
    if (r.harness_session_id) prevHarness = r.harness_session_id;

    events.push({
      id: r.message_id,
      kind: r.role === "user" ? "user" : "assistant",
      at: r.created_at.toISOString(),
      title: r.role === "user" ? "You" : "Agent",
      detail: previewParts(r.parts),
      status: r.status,
    });
  }

  if (session.status === "dead" || session.status === "failed") {
    events.push({
      id: `${session_id}:ended`,
      kind: "ended",
      at: (session.stopped_at ?? new Date()).toISOString(),
      title: session.status === "dead" ? "Sandbox ended" : "Session failed",
      detail: session.failure_reason ?? undefined,
    });
  }

  return events;
}
