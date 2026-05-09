/**
 * Orphan reconciler — periodic sweep that keeps Fargate task state and DB
 * session rows in agreement. Ported from
 * litellm/proxy/managed_agents_endpoints/lifecycle.py.
 *
 * Two cleanup paths live here:
 *
 * 1. Pre-delete (handler-driven): `stopSessionsForAgent` is called from the
 *    DELETE /agents/:id route to stop live Fargate tasks before the agent row
 *    is removed. DB cascade handles the session rows.
 *
 * 2. Background sweep: `reconcileOrphans` is invoked every
 *    RECONCILE_INTERVAL_SECONDS by src/worker/index.ts. It lists every tagged
 *    Fargate task in the configured cluster and stops anything whose DB row
 *    is missing, dead, or stuck creating past the timeout.
 *
 * The `RECONCILE_NEW_TASK_GRACE_MS` window covers the race between RunTask
 * returning and the session row being committed — without it, freshly
 * launched tasks would be killed seconds after starting.
 */

import { prisma } from "@/server/db";
import { listTaggedTasks, stopTask } from "@/server/fargate";
import {
  RECONCILE_NEW_TASK_GRACE_MS,
  SESSION_CREATING_TIMEOUT_MS,
  type ReconcileResult,
} from "@/server/types";

const DEAD_STATUSES = new Set(["dead", "failed", "stopped"]);

async function safeStopTask(task_arn: string, reason: string): Promise<void> {
  try {
    await stopTask(task_arn, reason);
  } catch (e) {
    console.warn(
      `reconcile: stopTask failed arn=${task_arn} reason="${reason}":`,
      e,
    );
  }
}

export async function reconcileOrphans(): Promise<ReconcileResult> {
  const tasks = await listTaggedTasks();
  const managed = tasks.filter((t) => t.session_id);
  const inspected = managed.length;

  let stopped = 0;
  const now = Date.now();

  // Batch the row lookup so we don't issue N queries.
  const sessionIds = managed
    .map((t) => t.session_id)
    .filter((sid): sid is string => typeof sid === "string" && sid.length > 0);
  const rows = sessionIds.length
    ? await prisma.session.findMany({
        where: { session_id: { in: sessionIds } },
      })
    : [];
  const bySessionId = new Map(rows.map((r) => [r.session_id, r]));

  for (const task of managed) {
    const sid = task.session_id as string;
    const row = bySessionId.get(sid);

    if (!row) {
      // Row missing: only stop if the task is older than the grace window.
      const startedAt = task.started_at ? task.started_at.getTime() : null;
      const ageMs = startedAt !== null ? now - startedAt : null;
      if (ageMs !== null && ageMs < RECONCILE_NEW_TASK_GRACE_MS) {
        continue;
      }
      await safeStopTask(task.task_arn, "reconciler: orphan");
      stopped += 1;
      continue;
    }

    if (DEAD_STATUSES.has(row.status)) {
      await safeStopTask(task.task_arn, "reconciler: orphan");
      stopped += 1;
    }
  }

  // Stuck-creating sweep: sessions whose creating window expired never got a
  // ready signal. Mark them failed and stop any associated task.
  const cutoff = new Date(now - SESSION_CREATING_TIMEOUT_MS);
  const stuck = await prisma.session.findMany({
    where: { status: "creating", created_at: { lt: cutoff } },
  });

  let failed_creating = 0;
  for (const s of stuck) {
    if (s.task_arn) {
      await safeStopTask(s.task_arn, "reconciler: creating timeout");
    }
    try {
      await prisma.session.update({
        where: { session_id: s.session_id },
        data: {
          status: "failed",
          failure_reason: "creating timeout",
          stopped_at: new Date(),
        },
      });
      failed_creating += 1;
    } catch (e) {
      console.warn(
        `reconcile: failed to mark session ${s.session_id} failed:`,
        e,
      );
    }
  }

  return { inspected, stopped, failed_creating };
}

export async function stopSessionsForAgent(agent_id: string): Promise<number> {
  const sessions = await prisma.session.findMany({
    where: { agent_id, status: { in: ["creating", "ready"] } },
  });
  if (sessions.length === 0) return 0;

  let count = 0;
  for (const s of sessions) {
    if (s.task_arn) {
      await safeStopTask(s.task_arn, "agent deleted");
    }
    try {
      await prisma.session.update({
        where: { session_id: s.session_id },
        data: { status: "dead", stopped_at: new Date() },
      });
      count += 1;
    } catch (e) {
      console.warn(
        `stopSessionsForAgent: failed to mark session ${s.session_id} dead:`,
        e,
      );
    }
  }
  return count;
}
