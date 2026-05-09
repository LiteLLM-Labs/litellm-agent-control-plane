/**
 * Reconciler worker entrypoint.
 *
 * Standalone Node process that ticks `reconcileOrphans` on a fixed interval.
 * Run alongside the Next.js server (e.g. `node --import tsx src/worker/index.ts`)
 * so background sweeps don't depend on a request landing on a particular
 * Next instance.
 */

import { env } from "@/server/env";
import { reconcileOrphans } from "@/server/reconcile";

const intervalMs = env.RECONCILE_INTERVAL_SECONDS * 1000;

async function tick() {
  try {
    const r = await reconcileOrphans();
    if (r.stopped > 0 || r.failed_creating > 0) {
      console.log(
        `reconcile: inspected=${r.inspected} stopped=${r.stopped} failed_creating=${r.failed_creating}`,
      );
    }
  } catch (e) {
    console.error("reconcile tick failed:", e);
  }
}

setInterval(tick, intervalMs);
tick();
console.log(`reconciler worker started (interval=${intervalMs}ms)`);
