/**
 * POST /api/v1/managed_agents/sessions/[session_id]/sandbox/execute
 *
 * Called by the claude-code-brain-inline harness when its `execute` MCP tool
 * fires. Forwards a shell command to a previously-provisioned sandbox pod and
 * returns its stdout/stderr output.
 *
 * The sandbox must have been created via /sandbox/provision first. If the
 * named sandbox is not found in the in-process sandboxMap, executeSandbox
 * returns an error string rather than throwing, matching the harness's
 * expectation that tool output is always a string.
 *
 * Body: { sandbox_name: string, cmd: string }
 */

import { ZodError, z } from "zod";

import { assertAuth } from "@/server/auth";
import { executeSandbox } from "@/server/tools/sandboxTools";
import { HttpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

const ExecuteBody = z.object({
  sandbox_name: z.string().min(1, "sandbox_name is required"),
  cmd: z.string().min(1, "cmd is required"),
});

export async function POST(req: Request, ctx: RouteContext) {
  try {
    assertAuth(req);
    const { session_id } = await ctx.params;
    const body = ExecuteBody.parse(await req.json());

    const output = await executeSandbox(session_id, body.sandbox_name, body.cmd);

    return Response.json({ output });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof HttpError)
      return Response.json({ error: e.detail }, { status: e.status });
    if (e instanceof ZodError)
      return Response.json({ error: e.issues }, { status: 400 });
    console.error("sandbox/execute route error", e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
