/**
 * Append-only message log for sessions.
 *
 * One row per `HarnessMessage` ({info, parts}) as emitted by the harness —
 * stored verbatim in the JSONB `payload` column, no transformation. This
 * is the source of truth for:
 *
 *   1. Rendering a session in any browser without round-tripping the live
 *      harness pod (so a dead pod or a tab opened on a different device
 *      doesn't blind the UI).
 *   2. Rehydrating a fresh harness pod on /restart — every prior message
 *      is replayed through `formatHistoryAsText()` as the first user
 *      message of the new harness session.
 *
 * Concurrency: `appendEvent()` runs an `UPDATE ... RETURNING last_event_seq`
 * inside a tx, then inserts the row using the returned value. Row-level
 * locking on the `Session` row serialises concurrent appenders within the
 * same session, so `seq` is gap-free per session. Cross-session writes
 * proceed in parallel.
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "@/server/db";
import type { HarnessMessage } from "@/server/types";

export interface SessionEventRecord {
  event_id: string;
  session_id: string;
  seq: bigint;
  ts: Date;
  payload: HarnessMessage;
}

/**
 * Append one `HarnessMessage` to the session's event log. Returns the new
 * row. Wrapped in a tx so the seq counter and the insert agree on the same
 * value even under concurrent writes.
 */
export async function appendEvent(
  session_id: string,
  payload: HarnessMessage,
): Promise<SessionEventRecord> {
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.session.update({
      where: { session_id },
      data: { last_event_seq: { increment: 1 } },
      select: { last_event_seq: true },
    });
    const created = await tx.sessionEvent.create({
      data: {
        session_id,
        seq: updated.last_event_seq,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });
    return created;
  });
  return {
    event_id: row.event_id,
    session_id: row.session_id,
    seq: row.seq,
    ts: row.ts,
    payload: row.payload as unknown as HarnessMessage,
  };
}

/**
 * Append multiple `HarnessMessage`s in one tx — used after a harness reply
 * lands and we need to record every new message the bus produced. Preserves
 * harness-side ordering by inserting one row per message in the order given.
 *
 * Returns the highest `seq` written (or null if `payloads` was empty), so
 * callers can update their cursor without a follow-up read.
 */
export async function appendEvents(
  session_id: string,
  payloads: HarnessMessage[],
): Promise<bigint | null> {
  if (payloads.length === 0) return null;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.session.update({
      where: { session_id },
      data: { last_event_seq: { increment: payloads.length } },
      select: { last_event_seq: true },
    });
    const baseSeq = updated.last_event_seq - BigInt(payloads.length);
    await tx.sessionEvent.createMany({
      data: payloads.map((payload, i) => ({
        session_id,
        seq: baseSeq + BigInt(i + 1),
        payload: payload as unknown as Prisma.InputJsonValue,
      })),
    });
    return updated.last_event_seq;
  });
}

/**
 * Read the full message log for a session in seq order. Returns an array
 * of `HarnessMessage` — the same shape `harnessListMessages()` returns
 * today, so callers (UI renderer, restart replay) drop in unchanged.
 *
 * `sinceSeq` is exclusive — useful for cursor pagination from a long-poll
 * or SSE reconnect.
 */
export async function listEvents(
  session_id: string,
  sinceSeq?: bigint,
): Promise<HarnessMessage[]> {
  const rows = await prisma.sessionEvent.findMany({
    where: {
      session_id,
      ...(sinceSeq !== undefined ? { seq: { gt: sinceSeq } } : {}),
    },
    orderBy: { seq: "asc" },
    select: { payload: true },
  });
  return rows.map((r) => r.payload as unknown as HarnessMessage);
}

/**
 * Count rows for a session. Cheap (uses the unique index on session_id, seq).
 * Used by /messages route to decide whether to fall back to live harness
 * proxy for very fresh sessions that haven't been persisted yet.
 */
export async function countEvents(session_id: string): Promise<number> {
  return prisma.sessionEvent.count({ where: { session_id } });
}
