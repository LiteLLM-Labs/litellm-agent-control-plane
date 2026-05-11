/**
 * Linear OAuth specifics.
 *
 * Three things: build the authorize URL (with `actor=app` so we install as an
 * app-user, not a regular user), exchange the auth code for tokens, and
 * fetch the workspace + app_user_id.
 *
 * Per-agent model: client_id + client_secret come from the agent's
 * `AgentIntegrationConfig` (passed in via the adapter params). This module
 * never touches `process.env` for credentials.
 *
 * Docs: https://linear.app/developers/agents — scopes needed for delegation
 * are `app:assignable` and `app:mentionable`.
 */

import { fetch } from "undici";
import type {
  InstallMetadata,
  OAuthAdapter,
  TokenResponse,
} from "../../core/types";

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";

export const SCOPES = ["read", "write", "app:assignable", "app:mentionable"];

interface LinearTokenWire {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

async function postForm(
  body: Record<string, string>,
): Promise<LinearTokenWire> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `Linear token endpoint returned ${res.status}: ${await res.text()}`,
    );
  }
  return (await res.json()) as LinearTokenWire;
}

export function buildOAuthAdapter(): OAuthAdapter {
  return {
    authorizeUrl({ state, redirectUri, clientId }) {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", SCOPES.join(","));
      url.searchParams.set("state", state);
      // `actor=app` installs us as an app-user (delegateable) instead of as
      // the human user who clicked Connect. Required for app:assignable.
      url.searchParams.set("actor", "app");
      return url.toString();
    },

    async exchange({ code, redirectUri, clientId, clientSecret }): Promise<TokenResponse> {
      const wire = await postForm({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      });
      return {
        access_token: wire.access_token,
        refresh_token: wire.refresh_token,
        expires_in: wire.expires_in,
      };
    },

    async refresh({ refreshToken, clientId, clientSecret }): Promise<TokenResponse> {
      const wire = await postForm({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      });
      return {
        access_token: wire.access_token,
        refresh_token: wire.refresh_token,
        expires_in: wire.expires_in,
      };
    },

    async fetchInstallMetadata(accessToken: string): Promise<InstallMetadata> {
      const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          query: `query { viewer { id organization { id name } } }`,
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Linear GraphQL viewer query returned ${res.status}: ${await res.text()}`,
        );
      }
      const json = (await res.json()) as {
        data?: {
          viewer?: {
            id?: string;
            organization?: { id?: string; name?: string };
          };
        };
      };
      const viewer = json.data?.viewer;
      const org = viewer?.organization;
      if (!viewer?.id || !org?.id || !org?.name) {
        throw new Error("Linear viewer query missing id / organization");
      }
      return {
        workspace_id: org.id,
        workspace_name: org.name,
        // `app_user_id` is the agent's own user id in this workspace —
        // used by webhook.parse to dedup the agent's own activity echoes.
        metadata: { app_user_id: viewer.id },
      };
    },
  };
}
