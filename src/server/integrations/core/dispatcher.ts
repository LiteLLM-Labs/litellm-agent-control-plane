/**
 * Inbound + outbound glue between integrations and LAP sessions.
 *
 * Inbound (webhook → LAP):
 *   raw POST → handleInbound(integration_id, req):
 *     1. Find the provider in the registry.
 *     2. Parse the JSON body, ask the provider which workspace it belongs
 *        to, look up IntegrationInstall.
 *     3. Provider verifies the signature against the install's secret.
 *     4. Provider translates the payload into a canonical IntegrationEvent.
 *     5. Dispatch:
 *          new_task → ack with a "thought" activity (Linear has a 10s
 *                     window), then async-spawn a LAP Session and write an
 *                     IntegrationSession row.
 *          followup → look up IntegrationSession by external_session_id,
 *                     forward the body to the existing LAP Session.
 *          cancel   → mark the LAP Session dead.
 *
 * Outbound (LAP session event → webhook):
 *   forwardSessionEvent(session_id, event):
 *     1. Look up IntegrationSession by session_id.
 *     2. Resolve provider + install + agent through the binding join.
 *     3. Call provider.onSessionEvent(...).
 *
 * Session create/send are delegated to the existing v1 routes via an
 * in-process fetch authenticated with the server's MASTER_KEY. That avoids
 * duplicating the warm-pool claim + cold-fallback logic in this file. When
 * those routes are someday factored into a server-side helper, swap the
 * fetches for direct calls.
 */

import { prisma } from "@/server/db";
import { env } from "@/server/env";
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
  req: Request,
): Promise<Response> {
  const integration = getProvider(integrationId);
  if (!integration) return errorResponse(404, "unknown integration");

  const body = await readBody(req);
  if (!body) return errorResponse(400, "invalid json");

  const workspaceId = integration.webhook.workspaceIdFromPayload(body.json);
  if (!workspaceId) return errorResponse(400, "could not resolve workspace");

  const install = await prisma.integrationInstall.findUnique({
    where: {
      integration_id_workspace_id: {
        integration_id: integration.id,
        workspace_id: workspaceId,
      },
    },
  });
  if (!install) return errorResponse(404, "install not found");

  const verified = await integration.webhook.verify(
    body.raw,
    req.headers,
    install,
  );
  if (!verified) return errorResponse(401, "bad signature");

  const event = integration.webhook.parse(body.json, install);

  if (event.kind === "ignore") {
    return new Response(null, { status: 204 });
  }

  if (event.kind === "new_task") {
    const binding = await prisma.agentIntegrationBinding.findUnique({
      where: {
        agent_id_install_id: {
          agent_id: event.target_agent_id,
          install_id: install.install_id,
        },
      },
      include: { agent: true },
    });
    if (!binding || !binding.enabled) {
      return errorResponse(404, "agent not bound to this install");
    }

    // ACK inside the medium's deadline (Linear: 10s). The session spawn
    // below is fire-and-forget so we don't block this response.
    await integration.onSessionEvent({
      install,
      externalSessionId: event.external_session_id,
      event: {
        type: "thought",
        body: `Picking up ${event.external_ref ?? "task"}.`,
      },
      agent: binding.agent,
    });

    void spawnSessionForEvent({
      integration,
      install_id: install.install_id,
      binding_id: binding.binding_id,
      external_session_id: event.external_session_id,
      external_ref: event.external_ref ?? null,
      target_agent_id: event.target_agent_id,
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
  const ext = await prisma.integrationSession.findUnique({
    where: { session_id },
    include: {
      binding: { include: { install: true, agent: true } },
    },
  });
  if (!ext) return; // session didn't originate from an integration

  const integration = getProvider(ext.binding.install.integration_id);
  if (!integration) return;

  await integration.onSessionEvent({
    install: ext.binding.install,
    externalSessionId: ext.external_session_id,
    event,
    agent: ext.binding.agent,
  });
}

// ---------------------------------------------------------------------------
// Internal: spawn a LAP Session via the existing v1 route.
//
// v1 punts here instead of duplicating warm-pool + cold-fallback logic
// from src/app/api/v1/managed_agents/agents/[agent_id]/session/route.ts.
// The in-process fetch uses MASTER_KEY auth, same as the UI would.
// ---------------------------------------------------------------------------

interface SpawnInput {
  integration: Integration;
  install_id: string;
  binding_id: string;
  external_session_id: string;
  external_ref: string | null;
  target_agent_id: string;
  prompt: string;
}

async function spawnSessionForEvent(input: SpawnInput): Promise<void> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const url = `${baseUrl}/api/v1/managed_agents/agents/${encodeURIComponent(
    input.target_agent_id,
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
        binding_id: input.binding_id,
        external_ref: input.external_ref,
      },
    });
  } catch (err) {
    console.error("[integrations/dispatcher] spawn failed:", err);
    // Surface the failure to the medium so the user isn't left hanging.
    const reason = err instanceof Error ? err.message : String(err);
    const install = await prisma.integrationInstall.findUnique({
      where: { install_id: input.install_id },
    });
    if (install) {
      await input.integration
        .onSessionEvent({
          install,
          externalSessionId: input.external_session_id,
          event: { type: "error", body: `Failed to start session: ${reason}` },
          agent: { agent_id: input.target_agent_id } as never,
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
