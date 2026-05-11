/**
 * Generic OAuth flow for the integrations subsystem.
 *
 * The flow:
 *   1. UI hits `/api/integrations/oauth/{id}/authorize` → `startOAuth(...)` →
 *      302 to the provider's authorize URL with a CSRF `state` we minted.
 *   2. Provider redirects back to `/api/integrations/oauth/{id}/callback` →
 *      `completeOAuth(...)` validates the state, exchanges the code, fetches
 *      install metadata, upserts an `IntegrationInstall` row with the tokens
 *      encrypted at rest.
 *
 * The state store is an in-process Map with a 10-minute TTL. That works for
 * a single LAP instance; a multi-instance deployment would need a shared
 * store (Redis / Postgres) — flagged in the README under "open issues".
 *
 * The dispatcher uses `getAccessToken(install_id)` to get a usable bearer
 * token, transparently refreshing if it's within 5 minutes of expiry.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@/server/db";
import { encryptToken, decryptToken } from "./crypto";
import type { Integration } from "./types";

const STATE_TTL_MS = 10 * 60_000;
const REFRESH_BUFFER_MS = 5 * 60_000;

interface StateEntry {
  integrationId: string;
  redirectUri: string;
  expiresAt: number;
}

const stateStore = new Map<string, StateEntry>();

function sweepExpiredStates(now: number): void {
  for (const [k, v] of stateStore) {
    if (v.expiresAt < now) stateStore.delete(k);
  }
}

/**
 * Mint a CSRF state, remember which integration + redirect_uri it's for, and
 * return the provider's authorize URL. The caller (the authorize route) does
 * a 302 to that URL.
 */
export function startOAuth(
  integration: Integration,
  redirectUri: string,
): string {
  const state = randomBytes(16).toString("hex");
  const now = Date.now();
  sweepExpiredStates(now);
  stateStore.set(state, {
    integrationId: integration.id,
    redirectUri,
    expiresAt: now + STATE_TTL_MS,
  });
  return integration.oauth.authorizeUrl({ state, redirectUri });
}

export interface CompleteOAuthInput {
  integration: Integration;
  code: string;
  state: string;
  createdBy?: string | null;
}

export interface CompleteOAuthResult {
  install_id: string;
  workspace_name: string;
}

/**
 * Validate the OAuth callback: state must match a recent mint for this
 * integration, exchange the code for tokens, fetch metadata, upsert the
 * install row. Throws if state is invalid/expired/cross-integration.
 */
export async function completeOAuth(
  input: CompleteOAuthInput,
): Promise<CompleteOAuthResult> {
  const stored = stateStore.get(input.state);
  stateStore.delete(input.state);
  const now = Date.now();
  if (!stored) throw new Error("OAuth state not found");
  if (stored.expiresAt < now) throw new Error("OAuth state expired");
  if (stored.integrationId !== input.integration.id) {
    throw new Error("OAuth state belongs to a different integration");
  }

  const token = await input.integration.oauth.exchange({
    code: input.code,
    redirectUri: stored.redirectUri,
  });
  const meta = await input.integration.oauth.fetchInstallMetadata(
    token.access_token,
  );

  const expiresAt =
    typeof token.expires_in === "number"
      ? new Date(Date.now() + token.expires_in * 1000)
      : null;
  const encryptedAccess = encryptToken(token.access_token);
  const encryptedRefresh = token.refresh_token
    ? encryptToken(token.refresh_token)
    : null;

  const install = await prisma.integrationInstall.upsert({
    where: {
      integration_id_workspace_id: {
        integration_id: input.integration.id,
        workspace_id: meta.workspace_id,
      },
    },
    update: {
      access_token: encryptedAccess,
      refresh_token: encryptedRefresh,
      expires_at: expiresAt,
      metadata: (meta.metadata ?? {}) as object,
      workspace_name: meta.workspace_name,
    },
    create: {
      integration_id: input.integration.id,
      workspace_id: meta.workspace_id,
      workspace_name: meta.workspace_name,
      access_token: encryptedAccess,
      refresh_token: encryptedRefresh,
      expires_at: expiresAt,
      metadata: (meta.metadata ?? {}) as object,
      created_by: input.createdBy ?? null,
    },
  });

  return {
    install_id: install.install_id,
    workspace_name: install.workspace_name,
  };
}

/**
 * Get a usable access token for an install. Transparently refreshes if the
 * stored token is within `REFRESH_BUFFER_MS` of expiry and the provider
 * supports refresh.
 */
export async function getAccessToken(
  install_id: string,
  integration: Integration,
): Promise<string> {
  const install = await prisma.integrationInstall.findUniqueOrThrow({
    where: { install_id },
  });

  const expires = install.expires_at?.getTime();
  const needsRefresh =
    typeof expires === "number" && expires - Date.now() < REFRESH_BUFFER_MS;

  if (
    needsRefresh &&
    integration.oauth.refresh &&
    install.refresh_token !== null
  ) {
    const refreshed = await integration.oauth.refresh(
      decryptToken(install.refresh_token),
    );
    const newExpires =
      typeof refreshed.expires_in === "number"
        ? new Date(Date.now() + refreshed.expires_in * 1000)
        : null;
    await prisma.integrationInstall.update({
      where: { install_id },
      data: {
        access_token: encryptToken(refreshed.access_token),
        refresh_token: refreshed.refresh_token
          ? encryptToken(refreshed.refresh_token)
          : install.refresh_token,
        expires_at: newExpires,
      },
    });
    return refreshed.access_token;
  }

  return decryptToken(install.access_token);
}
