/**
 * Inbound + outbound glue between integrations and LAP sessions.
 *
 * Per-agent model: every webhook URL includes the `agent_id`, so the
 * dispatcher knows which AgentIntegrationConfig to consult for the
 * webhook-signing secret without any payload-based lookup.
 *
 * Inbound (webhook → LAP):
 *   POST /api/integrations/webhooks/{integration}/{agent_id}
 *     1. Find the provider in the registry.
 *     2. Load AgentIntegrationConfig for (agent_id, integration). If missing
 *        or disabled → 404.
 *     3. Parse JSON, ask the provider which workspace it's for, look up
 *        the matching IntegrationInstall (must match agent_id too).
 *     4. Provider verifies the signature using the config's webhook_secret.
 *     5. Provider parses the payload into a canonical IntegrationEvent.
 *     6. Dispatch:
 *          new_task → thought ack (Linear: 10s window), then async-spawn a
 *                     LAP Session and write an IntegrationSession row.
 *          followup → look up IntegrationSession, forward to LAP Session.
 *          cancel   → mark the LAP Session dead.
 *
 * Outbound (LAP session event → webhook):
 *   forwardSessionEvent(session_id, event)
 *     1. Look up IntegrationSession by session_id (with retry to absorb
 *        the race against spawnSessionForEvent's row-write).
 *     2. Resolve provider + install + agent.
 *     3. Call provider.onSessionEvent(...).
 *
 * Session create/send are delegated to the existing v1 routes via in-process
 * fetch authenticated with the server's MASTER_KEY.
 */

import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { decryptToken } from "./crypto";
import { getProvider } from "./registry";
import type { Integration, SessionEvent } from "./types";

interface ParsedRequest {
  raw: Buffer;
  json: unknown;
}

async function readBody(req: Request): Promise<ParsedRequest | null> {
  const raw = Buffer.from(await req.arrayBuffer());
  try {
    return { raw, json: JSON.parse(raw.toString("utf8")) };
  } catch {
    return null;
  }
}

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleInbound(
  integrationId: string,
  agentId: string,
  req: Request,
): Promise<Response> {
  const integration = getProvider(integrationId);
  if (!integration) return errorResponse(404, "unknown integration");

  const config = await prisma.agentIntegrationConfig.findUnique({
    where: {
      agent_id_integration_id: {
        agent_id: agentId,
        integration_id: integrationId,
      },
    },
    include: { agent: true },
  });
  if (!config || !config.enabled) {
    return errorResponse(404, "no integration configured for this agent");
  }

  const body = await readBody(req);
  if (!body) return errorResponse(400, "invalid json");

  const workspaceId = integration.webhook.workspaceIdFromPayload(body.json);
  if (!workspaceId) return errorResponse(400, "could not resolve workspace");

  const install = await prisma.integrationInstall.findUnique({
    where: {
      agent_id_integration_id_workspace_id: {
        agent_id: agentId,
        integration_id: integrationId,
        workspace_id: workspaceId,
      },
    },
  });
  if (!install) return errorResponse(404, "install not found for this agent + workspace");

  const webhookSecret = decryptToken(config.webhook_secret_enc);
  const verified = await integration.webhook.verify(body.raw, req.headers, {
    webhookSecret,
    install,
  });
  if (!verified) return errorResponse(401, "bad signature");

  const event = integration.webhook.parse(body.json, install);

  if (event.kind === "ignore") {
    return new Response(null, { status: 204 });
  }

  if (event.kind === "new_task") {
    // ACK inside the medium's deadline (Linear: 10s). The session spawn
    // below is fire-and-forget so we don't block this response.
    await integration.onSessionEvent({
      install,
      externalSessionId: event.external_session_id,
      event: {
        type: "thought",
        body: `Picking up ${event.external_ref ?? "task"}.`,
      },
      agent: config.agent,
    });

    void spawnSessionForEvent({
      integration,
      install_id: install.install_id,
      external_session_id: event.external_session_id,
      external_ref: event.external_ref ?? null,
      agent_id: agentId,
      prompt: event.prompt,
    });

    return new Response(null, { status: 202 });
  }

  if (event.kind === "followup") {
    const ext = await prisma.integrationSession.findUnique({
      where: { external_session_id: event.external_session_id },
    });
    if (!ext) return errorResponse(404, "no session for that external id");

    void sendFollowupToSession({ session_id: ext.session_id, body: event.body });
    return new Response(null, { status: 202 });
  }

  if (event.kind === "cancel") {
    const ext = await prisma.integrationSession.findUnique({
      where: { external_session_id: event.external_session_id },
    });
    if (ext) {
      await prisma.session
        .update({
          where: { session_id: ext.session_id },
          data: { status: "dead", stopped_at: new Date() },
        })
        .catch(() => {
          /* best-effort */
        });
    }
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Outbound: forward a LAP SessionEvent to whatever integration delegated it.
// ---------------------------------------------------------------------------

export async function forwardSessionEvent(
  session_id: string,
  event: SessionEvent,
): Promise<void> {
  // Absorb the race with spawnSessionForEvent: the IntegrationSession row is
  // written only after the v1 session create returns, so an outbound harness
  // event in that gap would otherwise silently drop. Retry the lookup for up
  // to ~500ms before giving up.
  let ext: Awaited<ReturnType<typeof findIntegrationSession>> = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    ext = await findIntegrationSession(session_id);
    if (ext) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ext) {
    console.warn(
      `[integrations/dispatcher] no IntegrationSession for session_id=${session_id}; event dropped`,
    );
    return;
  }

  const integration = getProvider(ext.install.integration_id);
  if (!integration) return;

  await integration.onSessionEvent({
    install: ext.install,
    externalSessionId: ext.external_session_id,
    event,
    agent: ext.install.agent,
  });
}

function findIntegrationSession(session_id: string) {
  return prisma.integrationSession.findUnique({
    where: { session_id },
    include: {
      install: { include: { agent: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// Internal: spawn a LAP Session via the existing v1 route.
// ---------------------------------------------------------------------------

interface SpawnInput {
  integration: Integration;
  install_id: string;
  external_session_id: string;
  external_ref: string | null;
  agent_id: string;
  prompt: string;
}

async function spawnSessionForEvent(input: SpawnInput): Promise<void> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const url = `${baseUrl}/api/v1/managed_agents/agents/${encodeURIComponent(
    input.agent_id,
  )}/session`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.MASTER_KEY}`,
      },
      body: JSON.stringify({
        initial_prompt: input.prompt,
        title: input.external_ref ?? "integration task",
      }),
    });
    if (!res.ok) {
      throw new Error(`session create failed: ${res.status} ${await res.text()}`);
    }
    const session = (await res.json()) as { session_id: string };
    await prisma.integrationSession.create({
      data: {
        external_session_id: input.external_session_id,
        session_id: session.session_id,
        install_id: input.install_id,
        external_ref: input.external_ref,
      },
    });
  } catch (err) {
    console.error("[integrations/dispatcher] spawn failed:", err);
    const reason = err instanceof Error ? err.message : String(err);
    const install = await prisma.integrationInstall.findUnique({
      where: { install_id: input.install_id },
      include: { agent: true },
    });
    if (install) {
      await input.integration
        .onSessionEvent({
          install,
          externalSessionId: input.external_session_id,
          event: { type: "error", body: `Failed to start session: ${reason}` },
          agent: install.agent,
        })
        .catch(() => {
          /* best-effort */
        });
    }
  }
}

async function sendFollowupToSession(args: {
  session_id: string;
  body: string;
}): Promise<void> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const url = `${baseUrl}/api/v1/managed_agents/sessions/${encodeURIComponent(
    args.session_id,
  )}/message`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.MASTER_KEY}`,
      },
      body: JSON.stringify({ message: args.body }),
    });
    if (!res.ok) {
      throw new Error(`followup failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error("[integrations/dispatcher] followup failed:", err);
  }
}
