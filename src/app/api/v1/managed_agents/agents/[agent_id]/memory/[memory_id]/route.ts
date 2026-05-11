/**
 * /api/v1/managed_agents/agents/{agent_id}/memory/{memory_id}
 *
 * PATCH  — partial update. Only the fields you pass are touched, so an
 *          empty body is a no-op (not a silent overwrite to defaults).
 *          Disabling a memory hides it from prompt pre-load + search but
 *          keeps the row for audit.
 *
 * DELETE — hard-delete. Use sparingly; prefer disabling.
 *
 * Both invalidate warm tasks so the pre-loaded prompt refreshes on next
 * launch.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import {
  UpdateMemoryBody,
  httpError,
  toApiMemory,
} from "@/server/types";
import { wrap } from "@/server/route-helpers";
import { deleteMemory, updateMemory } from "@/server/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string; memory_id: string }>;
}

export const PATCH = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id, memory_id } = await ctx.params;

  const existing = await prisma.memory.findUnique({ where: { memory_id } });
  if (existing === null) httpError(404, `memory '${memory_id}' not found`);
  if (existing.agent_id !== agent_id) {
    httpError(404, `memory '${memory_id}' not found`);
  }

  const body = UpdateMemoryBody.parse(await req.json());
  const updated = await updateMemory(memory_id, body);
  if (updated === null) httpError(404, `memory '${memory_id}' not found`);
  return Response.json(toApiMemory(updated));
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id, memory_id } = await ctx.params;

  const existing = await prisma.memory.findUnique({ where: { memory_id } });
  if (existing === null) httpError(404, `memory '${memory_id}' not found`);
  if (existing.agent_id !== agent_id) {
    httpError(404, `memory '${memory_id}' not found`);
  }

  await deleteMemory(memory_id);
  return new Response(null, { status: 204 });
});
