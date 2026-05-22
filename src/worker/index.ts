/**
 * Reconciler worker entrypoint.
 *
 * Standalone Node process that ticks `reconcileOrphans` and `topUpWarmPool`
 * on a fixed interval. Run alongside the Next.js server (e.g.
 * `node --import tsx src/worker/index.ts`) so background sweeps don't depend
 * on a request landing on a particular Next instance.
 *
 * Both ticks share the same loop:
 *   - reconcileOrphans: deletes Sandbox CRs whose DB row is gone / terminal.
 *   - topUpWarmPool:    drives the warm pool toward `WARM_POOL_SIZE`.
 *
 * Reconcile is always on; warm-pool top-up is a no-op when
 * `WARM_POOL_SIZE=0`, so disabled deploys don't hit the DB at all on this
 * code path.
 */

import http from "http";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { reconcileOrphans } from "@/server/reconcile";
import { topUpWarmPool } from "@/server/warmPool";
import { reconcileAutomationRuns, tickAutomations } from "@/server/automations";
import { registry } from "@/server/metrics";

const intervalMs = env.RECONCILE_INTERVAL_SECONDS * 1000;

async function tick() {
  const tickStart = Date.now();
  let k8s_ok = true;
  let r = { inspected: 0, stopped: 0, failed_creating: 0, idle_killed: 0, warm_orphans_stopped: 0, ghost_killed: 0, warm_stale_killed: 0 };
  let t = { provisioned: 0, recycled: 0, fallback_dead: 0 };
  let a = { claimed: 0, fired: 0, failed: 0 };

  try {
    r = await reconcileOrphans();
    registry.inc("reconcile_failed_creating_total",   {}, r.failed_creating);
    registry.inc("reconcile_idle_killed_total",        {}, r.idle_killed);
    registry.inc("reconcile_ghost_killed_total",       {}, r.ghost_killed);
    registry.inc("reconcile_warm_stale_killed_total",  {}, r.warm_stale_killed);
  } catch (e) {
    k8s_ok = false;
    console.error("reconcile tick failed:", e);
  }

  // Top-up runs after reconcile so any budget freed by recycling dead /
  // TTL-expired warm rows is reflected on the same tick. Guarded by
  // WARM_POOL_SIZE so disabled deploys don't even hit the DB.
  if (env.WARM_POOL_SIZE > 0) {
    try {
      t = await topUpWarmPool();
    } catch (e) {
      console.error("warm_pool tick failed:", e);
    }
  }

  // Fire any due scheduled automations. Independent of the warm pool — always
  // on. Claiming is multi-pod safe (FOR UPDATE SKIP LOCKED), so running this
  // on every worker instance can't double-fire a schedule.
  try {
    a = await tickAutomations();
    registry.inc("automations_fired_total", {}, a.fired);
    registry.inc("automations_failed_total", {}, a.failed);
  } catch (e) {
    console.error("automations tick failed:", e);
  }

  // Resolve in-flight automation runs (succeeded/failed) by inspecting their
  // spawned sessions. Independent of whether anything fired this tick.
  try {
    const rec = await reconcileAutomationRuns();
    registry.inc("automation_runs_resolved_total", {}, rec.resolved);
  } catch (e) {
    console.error("automation runs reconcile failed:", e);
  }

  const elapsed = Date.now() - tickStart;
  registry.observe("reconcile_duration_seconds", {}, elapsed / 1000);

  // Heartbeat — emitted every tick so operators can confirm the worker is
  // alive and K8s is reachable without waiting for a non-zero event.
  console.log(
    `reconcile: ok=${k8s_ok} elapsed_ms=${elapsed}` +
    ` inspected=${r.inspected} stopped=${r.stopped}` +
    ` failed_creating=${r.failed_creating} idle_killed=${r.idle_killed}` +
    ` ghost_killed=${r.ghost_killed} warm_stale_killed=${r.warm_stale_killed}` +
    ` warm_provisioned=${t.provisioned} warm_recycled=${t.recycled}` +
    ` automations_fired=${a.fired} automations_failed=${a.failed}`,
  );
}

// On startup: mark warm tasks stuck in 'provisioning' as dead so topUpWarmPool
// can provision fresh ones. Provisioning promises die when the worker restarts
// mid-provision; without this cleanup they block the pool indefinitely.
if (env.WARM_POOL_SIZE > 0) {
  prisma.warmTask.updateMany({
    where: {
      status: "provisioning",
      created_at: { lt: new Date(Date.now() - 5 * 60 * 1000) },
    },
    data: {
      status: "dead",
      failure_reason: "provisioning interrupted — worker restarted",
    },
  }).then(({ count }: { count: number }) => {
    if (count > 0) console.log(`startup: cleared ${count} stuck provisioning warm task(s)`);
  }).catch(() => {});
}

// Prometheus scrape endpoint — no auth, internal cluster traffic only.
http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(registry.renderText());
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(9091);

setInterval(tick, intervalMs);
tick();
console.log(
  `reconciler worker started (interval=${intervalMs}ms, warm_pool_size=${env.WARM_POOL_SIZE})`,
);
