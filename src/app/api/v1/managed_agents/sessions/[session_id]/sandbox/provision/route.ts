/**
 * POST /api/v1/managed_agents/sessions/[session_id]/sandbox/provision
 *
 * Called by the claude-code-brain-inline harness when its `provision` MCP tool
 * fires. Spins up a K8s sandbox pod for the named project and registers the
 * resulting URL in the in-process sandboxMap so subsequent /execute calls can
 * reach it.
 *
 * Body: { name: string, project_id: string }
 *   - name       — logical sandbox name within the session (e.g. "main")
 *   - project_id — ID of a project entry in agent.projects (JSON array)
 *
 * The agent's repo_url is overridden with the project's repo_url before the
 * pod is created so the sandbox clones the correct repository.
 */

import { ZodError, z } from "zod";

import type { Prisma } from "@prisma/client";

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { provisionSandbox } from "@/server/tools/sandboxTools";
import { HttpError, httpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

const ProvisionBody = z.object({
  name: z.string().min(1, "name is required"),
  project_id: z.string().min(1, "project_id is required"),
});

interface ProjectEntry {
  id: string;
  repo_url: string;
  branch?: string;
  [key: string]: unknown;
}

function isProjectEntry(v: Prisma.JsonValue): v is ProjectEntry & Prisma.JsonObject {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, Prisma.JsonValue>).id === "string" &&
    typeof (v as Record<string, Prisma.JsonValue>).repo_url === "string"
  );
}

export async function POST(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;
    const body = ProvisionBody.parse(await req.json());

    const row = await prisma.session.findUnique({
      where: { session_id },
      include: { agent: true },
    });
    if (!row) httpError(404, `session ${session_id} not found`);

    const agent = row.agent;

    // Locate the project within the agent's projects JSON array.
    // agent.projects is Prisma.JsonValue — cast to array safely.
    const rawProjects: Prisma.JsonValue[] = Array.isArray(agent.projects)
      ? (agent.projects as Prisma.JsonValue[])
      : [];
    const project = rawProjects.find(
      (p): p is ProjectEntry & Prisma.JsonObject =>
        isProjectEntry(p) && (p as Record<string, Prisma.JsonValue>).id === body.project_id,
    );
    if (!project) {
      httpError(
        404,
        `project ${body.project_id} not found on agent ${agent.agent_id}`,
      );
    }

    // Shallow-clone the agent row, overriding repo_url / branch with the
    // project's values so the sandbox pod clones the correct repository.
    const projectRepoUrl = project.repo_url as string;
    const projectBranch = typeof project.branch === "string" ? project.branch : "main";
    const agentWithProject = {
      ...agent,
      repo_url: projectRepoUrl,
      branch: projectBranch,
    };

    await provisionSandbox(session_id, body.name, agentWithProject);

    return Response.json({ message: `sandbox '${body.name}' ready` });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    if (e instanceof ZodError)
      return Response.json({ error: e.issues }, { status: 400 });
    console.error("sandbox/provision route error", e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
