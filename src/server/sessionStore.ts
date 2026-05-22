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
        // Atomic claim: only the caller that actually flips this turn from
        // `pending` to `complete` may append the assistant row. The conditional
        // UPDATE is the lock — concurrent `session.idle` snapshots (rapid-fire
        // idle events, or two tabs each holding an /event stream) race here, and
        // the loser sees count 0 and bails instead of inserting a duplicate
        // assistant turn at the next seq.
        const claim = await tx.sessionMessage.updateMany({
          where: { message_id: opts.user_message_id, status: "pending" },
          data: { status: "complete", completed_at: new Date() },
        });
        if (claim.count === 0) return;
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

/**
 * Reconcile the durable log against the harness thread after a turn settles.
 *
 * The web UI talks to the opencode harness directly (through the passthrough
 * proxy) and builds its view from the `/event` bus — it never POSTs to our
 * `/message` route, so the only place we learn a turn finished is `session.idle`
 * on that bus. On idle we snapshot the harness thread and call this to:
 *   1. mirror the thread into `Session.history` (title preview + restart-replay
 *      fallback), and
 *   2. complete the durable log's trailing `pending` user turn by appending the
 *      assistant reply pulled from the thread.
 *
 * Idempotent: if the trailing user turn is already complete (a repeat idle, or
 * a turn we already recorded), it only refreshes the history blob.
 */
export async function syncSessionThread(opts: {
  session_id: string;
  harness_session_id: string;
  thread: HarnessMessage[];
}): Promise<void> {
  const { session_id, harness_session_id, thread } = opts;
  try {
    await prisma.session.update({
      where: { session_id },
      data: { history: thread as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    console.warn(`syncSessionThread: history update failed for ${session_id}:`, err);
  }

  try {
    const last = await prisma.sessionMessage.findFirst({
      where: { session_id },
      orderBy: { seq: "desc" },
    });
    if (!last || last.role !== "user" || last.status !== "pending") return;

    const lastAssistant = [...thread]
      .reverse()
      .find((m) => m.info?.role === "assistant");
    if (!lastAssistant) return;

    await completeAssistantMessage({
      session_id,
      user_message_id: last.message_id,
      harness_session_id,
      response: { parts: lastAssistant.parts ?? [] },
    });
  } catch (err) {
    console.warn(`syncSessionThread: reconcile failed for ${session_id}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Session Log — a human-friendly event timeline derived from the durable log,
// powering the "Session Log" side panel in the UI.
// ---------------------------------------------------------------------------

export type SessionLogEventKind =
  | "created"
  | "user"
  | "thinking"
  | "tool"
  | "response"
  | "assistant" // collapsed fallback when only the durable log is available
  | "recovered"
  | "ended";

export interface SessionLogEvent {
  id: string;
  kind: SessionLogEventKind;
  at: string; // ISO timestamp
  title: string;
  detail?: string;
  // Compact trailing annotation, e.g. "1.2s · 186 tok" on a response.
  meta?: string;
  // For collapsed message events: pending | complete | failed.
  status?: string;
}

const PREVIEW_MAX = 600;
const THINKING_TYPES = new Set(["thinking", "reasoning"]);
const TOOL_TYPES = new Set(["tool", "tool-invocation", "tool_use", "tool-call"]);

function truncate(s: string, n = PREVIEW_MAX): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function joinTextParts(parts: HarnessMessagePart[]): string | undefined {
  const texts = parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => (p.text as string).trim())
    .filter(Boolean);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function toolLabel(p: HarnessMessagePart): string {
  const r = p as Record<string, unknown>;
  const state = (r.state ?? {}) as Record<string, unknown>;
  const name = r.tool ?? r.name ?? r.toolName ?? state.name;
  return typeof name === "string" && name ? name : "tool";
}

function toolDetail(p: HarnessMessagePart): string | undefined {
  const r = p as Record<string, unknown>;
  const state = (r.state ?? {}) as Record<string, unknown>;
  const status = typeof state.status === "string" ? state.status : undefined;
  const input = state.input ?? r.input;
  const segs: string[] = [];
  if (status) segs.push(status);
  if (input !== undefined) {
    segs.push(typeof input === "string" ? input : JSON.stringify(input));
  }
  return segs.length > 0 ? truncate(segs.join(" · "), 200) : undefined;
}

// "1.2s · 186 tok" from an assistant message's info block.
function assistantMeta(info: unknown): string | undefined {
  const i = (info ?? {}) as Record<string, unknown>;
  const time = (i.time ?? {}) as { created?: number; completed?: number };
  const tokens = (i.tokens ?? {}) as { output?: number };
  const segs: string[] = [];
  if (typeof time.created === "number" && typeof time.completed === "number") {
    const ms = time.completed - time.created;
    if (ms >= 0) segs.push(ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
  }
  if (typeof tokens.output === "number" && tokens.output > 0) {
    segs.push(`${tokens.output} tok`);
  }
  return segs.length > 0 ? segs.join(" · ") : undefined;
}

function msgTime(info: unknown, fallback: string): string {
  const created = ((info ?? {}) as { time?: { created?: number } }).time?.created;
  return typeof created === "number" ? new Date(created).toISOString() : fallback;
}

// Flatten a harness thread into a granular, Datadog-style event stream: one
// event per user message, and per assistant thinking / tool / response part.
function eventsFromThread(
  thread: HarnessMessage[],
  fallbackAt: string,
): SessionLogEvent[] {
  const out: SessionLogEvent[] = [];
  for (const m of thread) {
    const role = m.info?.role;
    const mid = m.info?.id ?? `${out.length}`;
    const at = msgTime(m.info, fallbackAt);
    const parts = Array.isArray(m.parts) ? m.parts : [];

    if (role === "user") {
      const text = joinTextParts(parts);
      // A rehydrated session replays the prior thread as one big user message —
      // surface it as a recovery marker instead of a wall of JSON.
      if (text && text.startsWith("<previous_session_history>")) {
        out.push({
          id: `${mid}:recovered`,
          kind: "recovered",
          at,
          title: "Session restored",
          detail: "Prior conversation replayed into a fresh sandbox.",
        });
        continue;
      }
      out.push({
        id: `${mid}:user`,
        kind: "user",
        at,
        title: "User message",
        detail: text ? truncate(text) : "[non-text content]",
      });
      continue;
    }

    if (role !== "assistant") continue;

    const meta = assistantMeta(m.info);
    let responseEmitted = false;
    parts.forEach((p, idx) => {
      const type = (p as { type?: string }).type;
      const id = `${mid}:${idx}`;
      if (type && THINKING_TYPES.has(type)) {
        const t = typeof p.text === "string" ? p.text : "";
        if (t.trim()) {
          out.push({ id, kind: "thinking", at, title: "Thinking", detail: truncate(t) });
        }
      } else if (type && TOOL_TYPES.has(type)) {
        out.push({
          id,
          kind: "tool",
          at,
          title: `Tool: ${toolLabel(p)}`,
          detail: toolDetail(p),
        });
      } else if (type === "text") {
        const t = typeof p.text === "string" ? p.text : "";
        if (t.trim()) {
          out.push({
            id,
            kind: "response",
            at,
            title: "Response",
            detail: truncate(t),
            // Attach the turn cost/latency to the first response part only.
            meta: responseEmitted ? undefined : meta,
          });
          responseEmitted = true;
        }
      }
      // step-start / step-finish / snapshot / file parts are intentionally skipped.
    });
  }
  return out;
}

// Collapsed fallback when no thread snapshot exists yet (durable log only).
function eventsFromDurableRows(rows: SessionMessageRow[]): SessionLogEvent[] {
  const out: SessionLogEvent[] = [];
  let prevHarness: string | null = null;
  for (const r of rows) {
    if (r.harness_session_id && prevHarness && r.harness_session_id !== prevHarness) {
      out.push({
        id: `${r.message_id}:recovered`,
        kind: "recovered",
        at: r.created_at.toISOString(),
        title: "Sandbox recovered",
        detail: "The previous sandbox ended; the conversation was replayed into a fresh one.",
      });
    }
    if (r.harness_session_id) prevHarness = r.harness_session_id;
    const parts = (Array.isArray(r.parts) ? r.parts : []) as HarnessMessagePart[];
    out.push({
      id: r.message_id,
      kind: r.role === "user" ? "user" : "assistant",
      at: r.created_at.toISOString(),
      title: r.role === "user" ? "User message" : "Agent",
      detail: joinTextParts(parts),
      status: r.status,
    });
  }
  return out;
}

/**
 * Build the Datadog-style event timeline for a session: creation, then a
 * granular stream of user messages and per-part assistant events (thinking,
 * each tool call, response), plus a terminal marker for dead/failed sessions.
 *
 * Primary source is the full harness thread snapshot (`Session.history`), which
 * carries reasoning + tool + text parts. Falls back to the collapsed durable
 * log when no snapshot exists yet.
 */
export async function getSessionLog(
  session_id: string,
): Promise<SessionLogEvent[]> {
  const session = await prisma.session.findUnique({
    where: { session_id },
    select: {
      created_at: true,
      status: true,
      stopped_at: true,
      failure_reason: true,
      history: true,
    },
  });
  if (!session) return [];

  const createdAt = session.created_at.toISOString();
  const events: SessionLogEvent[] = [
    { id: `${session_id}:created`, kind: "created", at: createdAt, title: "Session created" },
  ];

  const thread = Array.isArray(session.history)
    ? (session.history as unknown as HarnessMessage[])
    : null;
  if (thread && thread.length > 0) {
    events.push(...eventsFromThread(thread, createdAt));
  } else {
    events.push(...eventsFromDurableRows(await listSessionMessages(session_id)));
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
