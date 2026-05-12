/**
 * /api/v1/managed_agents/agents
 *
 * GET  — list every agent, newest first, mapped through `toApiAgent`.
 * POST — create an agent. The request body is the user-facing slice
 *        (`CreateAgentBody`); we fill in the server-owned columns
 *        (`harness_id`, `task_definition_arn`, `container_port`, `created_by`)
 *        from env + the auth identity so callers can't override them.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import {
  CreateAgentBody,
  HARNESS_OPENCODE,
  KNOWN_HARNESSES,
  encryptEnvVars,
  httpError,
  toApiAgent,
} from "@/server/types";
import { wrap } from "@/server/route-helpers";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_SORT_FIELDS = new Set(["created_at", "name", "harness_id", "sessions"]);
const VALID_ORDERS = new Set(["asc", "desc"]);

export const GET = wrap(async (req: Request) => {
  assertAuth(req);
  const url = new URL(req.url);

  const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const offsetRaw = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

  const sortParam = url.searchParams.get("sort") ?? "created_at";
  const sort = VALID_SORT_FIELDS.has(sortParam) ? sortParam : "created_at";

  const orderParam = url.searchParams.get("order") ?? "desc";
  const order = VALID_ORDERS.has(orderParam) ? (orderParam as "asc" | "desc") : "desc";

  const search = url.searchParams.get("search")?.trim() ?? "";

  const where = search
    ? {
        OR: [
          { agent_name: { contains: search, mode: "insensitive" as const } },
          { agent_id: { contains: search, mode: "insensitive" as const } },
          { harness_id: { contains: search, mode: "insensitive" as const } },
        ],
      }
    : undefined;

  // "name" is the API param; Prisma model uses agent_name.
  const prismaSort = sort === "name" ? "agent_name" : sort;
  const orderBy =
    sort === "sessions"
      ? { sessions: { _count: order } }
      : { [prismaSort]: order };

  const [rows, total] = await Promise.all([
    prisma.agent.findMany({
      where,
      orderBy,
      take: limit,
      skip: offset,
      include: {
        _count: { select: { sessions: true } },
        // One active session is enough to know the agent is live.
        sessions: {
          where: { status: { in: ["ready", "creating"] } },
          select: { session_id: true },
          take: 1,
        },
      },
    }),
    prisma.agent.count({ where }),
  ]);

  return Response.json({
    data: rows.map((r) => ({
      ...toApiAgent(r),
      session_count: r._count.sessions,
      has_active_session: r.sessions.length > 0,
    })),
    total,
    limit,
    offset,
  });
});

export const POST = wrap(async (req: Request) => {
  const identity = assertAuth(req);
  const body = CreateAgentBody.parse(await req.json());
  const harness_id = body.harness_id ?? HARNESS_OPENCODE;
  if (!KNOWN_HARNESSES.has(harness_id)) {
    httpError(400, {
      error: `unknown harness_id "${harness_id}". Valid: ${[...KNOWN_HARNESSES].join(", ")}`,
    });
  }
  const created = await prisma.agent.create({
    data: {
      agent_name: body.name ?? null,
      model: body.model,
      prompt: body.prompt ?? null,
      // zod gives us `unknown[]`; Prisma's Json column wants InputJsonValue.
      // We trust the body here — the agent owner is authenticated.
      tools: body.tools as Prisma.InputJsonValue,
      harness_id,
      repo_url: body.repo_url ?? null,
      branch: body.branch ?? "main",
      pfp_url: body.pfp_url ?? null,
      mcp_servers: body.mcp_servers as Prisma.InputJsonValue,
      env_vars: encryptEnvVars(body.env_vars ?? {}) as Prisma.InputJsonValue,
      // Legacy column from the ECS era; on k8s we run the same harness
      // image for every Sandbox so we just stash that here. Plan is to
      // drop the column on the next schema bump.
      task_definition_arn: env.K8S_HARNESS_IMAGE,
      container_port: env.CONTAINER_PORT,
      created_by: identity.user_id,
    },
  });
  return Response.json(toApiAgent(created));
});
