import { NextResponse } from "next/server";

/**
 * Returns the public-safe portion of UI config. Currently just a `base_url`
 * the 'Call this agent' snippet card uses to render copyable cURL/Python/TS
 * examples — the URL users would hit from outside the app.
 *
 * With the local backend, the app and its API live on the same Next.js
 * origin, so there is no separate upstream URL to surface. We honor an
 * optional `UI_PUBLIC_BASE_URL` server env (e.g. "https://agents.acme.com")
 * for deployments that want the snippets to render the production hostname;
 * otherwise we return an empty string and the snippet card falls back to its
 * built-in default.
 *
 * No secrets are exposed here.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    base_url: process.env.UI_PUBLIC_BASE_URL ?? "",
  });
}
