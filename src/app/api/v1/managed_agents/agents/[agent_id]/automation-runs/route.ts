/**
 * GET /api/v1/managed_agents/agents/{agent_id}/automation-runs
 *
 * Run log for the agent page: most-recent automation runs, newest first, each
 * carrying its automation's name and the session it spawned. `?limit=` bounds
 * the result (default 50, max 200).
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { httpError, toApiAutomationRun } from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;
  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null) httpError(404, `agent '${agent_id}' not found`);

  const limitParam = Number(new URL(req.url).searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const rows = await prisma.automationRun.findMany({
    where: { agent_id },
    orderBy: { started_at: "desc" },
    take: limit,
    include: { automation: { select: { name: true } } },
  });
  return Response.json(
    rows.map((r) => toApiAutomationRun(r, r.automation?.name ?? null)),
  );
});
