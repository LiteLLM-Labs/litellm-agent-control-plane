/**
 * Bearer auth for v0 single-tenant UI.
 * See AuthIdentity / assertAuth / expectedBearer in src/server/types.ts.
 */

import { timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";
import type { AuthIdentity } from "@/server/types";

let cachedExpected: string | null = null;

export function expectedBearer(): string {
  if (cachedExpected === null) {
    cachedExpected = `Bearer ${env.MASTER_KEY}`;
  }
  return cachedExpected;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export function assertAuth(req: Request): AuthIdentity {
  const got = req.headers.get("authorization");
  const expected = expectedBearer();
  if (got === null) throw unauthorized();
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) throw unauthorized();
  if (!timingSafeEqual(a, b)) throw unauthorized();
  return { user_id: "ui" };
}
