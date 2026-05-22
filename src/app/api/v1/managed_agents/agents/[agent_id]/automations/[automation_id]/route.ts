/**
 * /api/v1/managed_agents/agents/{agent_id}/automations/{automation_id}
 *
 * PATCH  — partial update (name / instruction / cron_expr / enabled). Any
 *          change to the schedule or the enabled flag re-derives next_run_at
 *          from the resulting state, so the worker always sees an accurate
 *          due time.
 * DELETE — remove the automation.
 *
 * Both scope the lookup by agent_id so an automation_id from another agent
 * can't be edited or deleted through this agent's URL — a mismatch reads as
 * a 404 rather than leaking that the id exists elsewhere.
 */

import { assertAuth } from "@/server/auth";
import { computeNextRunAt } from "@/server/automations";
import { prisma } from "@/server/db";
import {
  httpError,
  toApiAutomation,
  UpdateAutomationBody,
} from "@/server/types";
import { wrap } from "@/server/route-helpers";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string; automation_id: string }>;
}

export const PATCH = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id, automation_id } = await ctx.params;
  const body = UpdateAutomationBody.parse(await req.json());

  const existing = await prisma.automation.findUnique({ where: { automation_id } });
  if (existing === null || existing.agent_id !== agent_id) {
    httpError(404, `automation '${automation_id}' not found`);
  }

  const data: Prisma.AutomationUpdateInput = {};
  if (body.instruction !== undefined) data.instruction = body.instruction;
  if (body.cron_expr !== undefined) data.cron_expr = body.cron_expr;
  if (body.name !== undefined) data.name = body.name;
  if (body.enabled !== undefined) data.enabled = body.enabled;

  // Re-derive next_run_at whenever the schedule or the enabled flag could
  // have changed. Disabled rows park at null; enabled rows get the next fire
  // for their (possibly new) cron.
  if (body.cron_expr !== undefined || body.enabled !== undefined) {
    const cron = body.cron_expr ?? existing!.cron_expr;
    const enabled = body.enabled ?? existing!.enabled;
    const nextRunAt = enabled ? computeNextRunAt(cron) : null;
    // Reject enabling a cron that has no future occurrence (e.g. "0 9 31 2 *")
    // rather than persisting an un-fireable row that still shows "Enabled".
    if (enabled && nextRunAt === null) {
      httpError(422, "cron expression has no future occurrences");
    }
    data.next_run_at = nextRunAt;
  }

  const updated = await prisma.automation.update({
    where: { automation_id },
    data,
  });
  return Response.json(toApiAutomation(updated));
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id, automation_id } = await ctx.params;

  const existing = await prisma.automation.findUnique({ where: { automation_id } });
  if (existing === null || existing.agent_id !== agent_id) {
    httpError(404, `automation '${automation_id}' not found`);
  }

  await prisma.automation.delete({ where: { automation_id } });
  return new Response(null, { status: 204 });
});
