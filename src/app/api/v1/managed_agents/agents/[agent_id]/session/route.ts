/**
 * POST /api/v1/managed_agents/agents/{agent_id}/session
 *
 * Spins up a Fargate task for the agent and creates an opencode harness
 * session inside it. The slow path (~50-120s) runs entirely inside the
 * request: RunTask → wait for ENI/IP → poll the harness HTTP port → POST
 * /session → optionally POST the initial prompt. We persist a `creating`
 * row up front so an in-flight failure leaves an auditable `failed` row
 * rather than a silently-orphaned task.
 *
 * Ported from litellm/proxy/managed_agents_endpoints/endpoints_sessions.py:
 * create_session — but stripped of the multi-tenant key minting and warm
 * pool logic (v0 of this UI is single-tenant cold-start only).
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import {
  runTask,
  waitHttpReady,
  waitRunningGetIp,
} from "@/server/fargate";
import {
  expandMessage,
  harnessCreateSession,
  harnessSendMessage,
} from "@/server/harness";
import {
  CreateSessionBody,
  HttpError,
  httpError,
  toApiSession,
  type AgentRow,
  type HarnessMessageResponse,
  type SessionRow,
} from "@/server/types";
import { wrap } from "@/server/route-helpers";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

interface BringUpResult {
  updated: SessionRow;
  response: HarnessMessageResponse | null;
}

async function bringUpSession(
  agent: AgentRow,
  session_id: string,
  body: { initial_prompt?: string; title?: string },
): Promise<BringUpResult> {
  const { task_arn } = await runTask({ agent, session_id });
  await prisma.session.update({
    where: { session_id },
    data: { task_arn },
  });
  const ip = await waitRunningGetIp(task_arn);
  const sandbox_url = `http://${ip}:${agent.container_port}`;
  await waitHttpReady(sandbox_url);
  const harness_session_id = await harnessCreateSession({
    sandbox_url,
    title: body.title,
  });
  let response: HarnessMessageResponse | null = null;
  if (body.initial_prompt) {
    response = await harnessSendMessage({
      sandbox_url,
      harness_session_id,
      model: agent.model,
      parts: expandMessage(body.initial_prompt),
    });
  }
  const updated = await prisma.session.update({
    where: { session_id },
    data: {
      status: "ready",
      sandbox_url,
      harness_session_id,
      // The harness reply is an opaque blob; Prisma's Json column wants
      // InputJsonValue. Skip the field entirely if no initial_prompt was sent.
      response: response
        ? (response as unknown as Prisma.InputJsonValue)
        : undefined,
    },
  });
  return { updated, response };
}

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const identity = assertAuth(req);
  const { agent_id } = await ctx.params;
  const body = CreateSessionBody.parse(await req.json().catch(() => ({})));

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null) httpError(404, `agent '${agent_id}' not found`);

  const session = await prisma.session.create({
    data: {
      agent_id,
      status: "creating",
      created_by: identity.user_id,
    },
  });

  try {
    const { updated, response } = await bringUpSession(
      agent,
      session.session_id,
      body,
    );
    return Response.json(toApiSession(updated, response));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await prisma.session
      .update({
        where: { session_id: session.session_id },
        data: { status: "failed", failure_reason: reason },
      })
      .catch(() => {
        /* best-effort; surface the original failure */
      });
    if (e instanceof HttpError || e instanceof Response) throw e;
    httpError(500, `session create failed: ${reason}`);
  }
});
