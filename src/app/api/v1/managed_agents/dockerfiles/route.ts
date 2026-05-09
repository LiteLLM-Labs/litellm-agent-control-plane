/**
 * GET /api/v1/managed_agents/dockerfiles
 *
 * v0 ships a single hard-coded harness ("opencode"). Returning the list as an
 * array keeps the wire shape forward-compatible with a future multi-harness
 * world without forcing the UI to change.
 */

import { assertAuth } from "@/server/auth";
import { env } from "@/server/env";
import {
  HARNESS_OPENCODE,
  type ApiDockerfile,
} from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(async (req: Request) => {
  assertAuth(req);
  const out: ApiDockerfile[] = [
    { id: HARNESS_OPENCODE, container_port: env.CONTAINER_PORT },
  ];
  return Response.json(out);
});
