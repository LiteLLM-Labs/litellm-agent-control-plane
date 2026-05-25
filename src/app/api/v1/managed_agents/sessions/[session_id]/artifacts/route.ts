import { wrap } from "@/server/route-helpers";
import { createArtifact } from "@/server/artifacts";
import { prisma } from "@/server/db";
import { assertAgentTokenOrMaster } from "@/server/auth";
import { env } from "@/server/env";
import { z } from "zod";
import { HttpError } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Allowlist of MIME types that agents may upload. Active-content types
// (text/html, application/javascript, image/svg+xml, etc.) are excluded —
// even with ResponseContentDisposition:attachment on the presigned URL,
// keeping them off the list is defense-in-depth against future mis-config.
const ALLOWED_MIME_TYPES = [
  "application/json",
  "application/pdf",
  "application/octet-stream",
  "application/zip",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/x-python",
  "text/x-typescript",
  "text/x-javascript",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
] as const;

const CreateArtifactSchema = z.object({
  name: z.string().min(1).max(255),
  mime_type: z.enum(ALLOWED_MIME_TYPES as unknown as [string, ...string[]]),
  // base64-encoded bytes; actual decoded-size cap (100 MB) enforced in createArtifact
  content: z.string().min(1).max(140 * 1024 * 1024),
  size: z.number().int().min(1).max(100 * 1024 * 1024),
});

interface RouteContext {
  params: Promise<{ session_id: string }>;
}

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { session_id } = await ctx.params;

  if (!env.ARTIFACT_STORAGE || !env.AWS_S3_BUCKET) {
    throw new HttpError(503, "artifact storage not configured");
  }

  // Look up session first to get agent_id — required for assertAgentTokenOrMaster.
  const session = await prisma.session.findUnique({
    where: { session_id },
    select: { agent_id: true, status: true },
  });

  if (!session) {
    throw new HttpError(404, "session not found");
  }

  // Auth after session lookup so we can pass the correct agent_id. A scoped
  // agent token must carry scope="artifacts" and match the session's agent_id;
  // the master key is also accepted for UI/CLI callers.
  assertAgentTokenOrMaster(req, { scope: "artifacts", agent_id: session.agent_id });

  if (session.status !== "ready") {
    throw new HttpError(400, "session not in ready state");
  }

  const body = await req.json();
  const { name, mime_type, content, size } = CreateArtifactSchema.parse(body);

  const artifact = await createArtifact({
    session_id,
    name,
    mime_type,
    content,
    size,
  });

  return Response.json(artifact);
});
