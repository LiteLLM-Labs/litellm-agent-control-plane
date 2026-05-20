/**
 * /api/v1/managed_agents/agents/{agent_id}/template
 *
 * POST — resync the agent's template_version to the latest version of its
 *        referenced template (Helm-style chart upgrade). The template prompt
 *        is read live at session spawn time, so no text is written to the DB —
 *        only the version counter is bumped. Warm tasks are invalidated so the
 *        next session picks up the new prompt.
 *
 * Returns { template_id, previous_version, new_version, status }.
 * 400 if the agent has no template_id.
 * 404 if the template no longer exists in agent_templates.json.
 * 200 with status: "already_up_to_date" if already at the latest version.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { invalidateWarmTasks } from "@/server/memory";
import { getTemplate } from "@/server/templates";
import { httpError } from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = wrap(
  async (req: Request, { params }: { params: Promise<{ agent_id: string }> }) => {
    const identity = assertAuth(req);
    const { agent_id } = await params;

    const agent = await prisma.agent.findFirst({
      where: { agent_id, created_by: identity.user_id },
      select: { agent_id: true, template_id: true, template_version: true },
    });
    if (!agent) httpError(404, "agent not found");

    if (!agent!.template_id) {
      httpError(400, "agent is not derived from a template");
    }

    const template = getTemplate(agent!.template_id!);
    if (!template) {
      httpError(404, `template "${agent!.template_id}" no longer exists`);
    }

    const previousVersion = agent!.template_version ?? 0;
    const newVersion = template!.version;

    if (previousVersion >= newVersion) {
      return Response.json({
        template_id: agent!.template_id,
        previous_version: previousVersion,
        new_version: newVersion,
        status: "already_up_to_date",
      });
    }

    await prisma.agent.update({
      where: { agent_id },
      data: { template_version: newVersion, template_prompt: template!.prompt },
    });

    // Invalidate warm tasks so the next session spawn reads the updated
    // template prompt rather than continuing from a pre-warmed pod with
    // the old AGENT_PROMPT baked in.
    await invalidateWarmTasks(agent_id);

    return Response.json({
      template_id: agent!.template_id,
      previous_version: previousVersion,
      new_version: newVersion,
      status: "synced",
    });
  },
);
