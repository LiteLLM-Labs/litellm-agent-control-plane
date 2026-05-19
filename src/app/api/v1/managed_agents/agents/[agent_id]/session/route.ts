/**
 * POST /api/v1/managed_agents/agents/{agent_id}/session
 *
 * Two paths:
 *
 *   warm  — claim a pre-provisioned Fargate task from the pool and run only
 *           the harness handshake (~5s on the happy path).
 *   cold  — fall through to the original RunTask + waits + harness flow
 *           (~30s-8min). Used when the pool is disabled
 *           (`WARM_POOL_SIZE=0`), drained, has no warm task for this
 *           agent's config, or the request carries per-session `env_vars`
 *           that wouldn't be in a warm task's container env.
 *
 * The handler returns the `creating` Session row immediately (~50ms) and
 * runs the bring-up fire-and-forget in the background. The UI polls
 * /sessions/{id} for the `ready` (or `failed`) flip — so a slow cold path
 * doesn't block the response and the user sees the session page right away
 * with a live progress indicator instead of a spinner on the agent page.
 *
 * The actual bring-up logic lives in `@/server/session-bringup` so the
 * worker's cron tick can reuse it (see src/server/cron.ts).
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { runBringUp } from "@/server/session-bringup";
import {
  CreateSessionBody,
  HttpError,
  httpError,
  toApiSession,
  type SessionRow,
} from "@/server/types";
import {
  claimWarmTask,
  markClaimedTaskDead,
  topUpWarmPool,
} from "@/server/warmPool";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const identity = assertAuth(req);
  const { agent_id } = await ctx.params;
  const body = CreateSessionBody.parse(await req.json().catch(() => ({})));

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null) httpError(404, `agent '${agent_id}' not found`);

  // Per-session `env_vars` are baked in at Fargate launch time. Warm tasks
  // were provisioned without them, so a request that carries env_vars
  // can't be served from the pool — always go cold.
  const hasEnvVars = body.env_vars && Object.keys(body.env_vars).length > 0;
  const warm = hasEnvVars ? null : await claimWarmTask(agent_id);
  // Replenish immediately on claim — don't wait for the 60s reconciler tick.
  if (warm) void topUpWarmPool().catch(() => {});

  let session: SessionRow;
  try {
    session = await prisma.session.create({
      data: {
        agent_id,
        status: "creating",
        created_by: identity.user_id,
        // Inherit the warm task's ARN so that even if bring-up dies between
        // the claim and the harness handshake, the orphan reconciler can
        // still trace the ECS task back to a Session row.
        ...(warm?.task_arn ? { task_arn: warm.task_arn } : {}),
        ...(warm?.sandbox_url ? { sandbox_url: warm.sandbox_url } : {}),
      },
    });
  } catch (e) {
    // Row creation itself failed — we have no Session row to mark failed,
    // so propagate as a 500 the way the old synchronous flow did. Release
    // any warm claim so it isn't orphaned.
    if (warm) {
      await markClaimedTaskDead(
        warm.warm_task_id,
        `session row create failed: ${e instanceof Error ? e.message : String(e)}`,
      ).catch(() => {});
    }
    if (e instanceof HttpError || e instanceof Response) throw e;
    httpError(500, `session create failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Fire-and-forget the bring-up. The Node runtime keeps the promise alive
  // after the response returns (unlike Edge, which terminates the
  // execution context). Render runs this route on Node so the background
  // work continues; nothing inside runBringUp reads request-scoped state.
  void runBringUp(agent, session.session_id, body, warm);

  // Return the `creating` row immediately. The UI polls /sessions/{id} and
  // flips to the ready/failed view when the background bring-up settles.
  return Response.json(toApiSession(session, null));
});
