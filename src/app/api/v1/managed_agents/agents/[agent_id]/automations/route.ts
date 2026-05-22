/**
 * /api/v1/managed_agents/agents/{agent_id}/automations
 *
 * GET   — list this agent's automations, soonest-due first.
 * POST  — create one. Validates the cron expression (CreateAutomationBody)
 *         and pre-computes next_run_at so the worker query stays a plain
 *         range scan. A disabled automation gets a null next_run_at so it's
 *         never claimed until re-enabled.
 */

import { assertAuth } from "@/server/auth";
import { computeNextRunAt } from "@/server/automations";
import { prisma } from "@/server/db";
import {
  CreateAutomationBody,
  httpError,
  toApiAutomation,
} from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;
  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null) httpError(404, `agent '${agent_id}' not found`);

  const rows = await prisma.automation.findMany({
    where: { agent_id },
    orderBy: [{ next_run_at: "asc" }, { created_at: "desc" }],
  });
  return Response.json(rows.map(toApiAutomation));
});

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const identity = assertAuth(req);
  const { agent_id } = await ctx.params;
  const body = CreateAutomationBody.parse(await req.json());

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null) httpError(404, `agent '${agent_id}' not found`);

  const enabled = body.enabled ?? true;
  const created = await prisma.automation.create({
    data: {
      agent_id,
      instruction: body.instruction,
      cron_expr: body.cron_expr,
      name: body.name ?? null,
      enabled,
      // Only schedule a fire when enabled; a disabled row sits with a null
      // next_run_at and is skipped by the worker until it's turned on.
      next_run_at: enabled ? computeNextRunAt(body.cron_expr) : null,
      created_by: identity.user_id,
    },
  });
  return Response.json(toApiAutomation(created), { status: 201 });
});
