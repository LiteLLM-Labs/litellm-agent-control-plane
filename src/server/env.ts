/**
 * Parses process.env into the locked ServerEnv contract from types.ts.
 * Crashes on import if required keys are missing — by design.
 */

import { z } from "zod";
import type { ServerEnv } from "@/server/types";

const CONTAINER_ENV_PREFIX = "CONTAINER_ENV_";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  UI_USERNAME: z.string().min(1),
  MASTER_KEY: z.string().min(8),
  AWS_REGION: z.string().min(1),
  AWS_CLUSTER: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_TASK_DEFINITION_ARN: z.string().min(1),
  AWS_SUBNETS: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    )
    .refine((arr) => arr.length > 0, {
      message: "AWS_SUBNETS must contain at least one subnet id",
    }),
  AWS_SECURITY_GROUP: z.string().min(1),
  PREINSTALLED_GITHUB_REPO: z.string().min(1),
  LITELLM_API_BASE: z.string().min(1),
  LITELLM_API_KEY: z.string().min(1),
  CONTAINER_PORT: z.coerce.number().int().positive().default(4096),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
});

function collectContainerEnvPassthrough(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(CONTAINER_ENV_PREFIX)) continue;
    if (typeof value !== "string") continue;
    const stripped = key.slice(CONTAINER_ENV_PREFIX.length);
    if (stripped.length === 0) continue;
    out[stripped] = value;
  }
  return out;
}

function parseEnv(): ServerEnv {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid server environment configuration:\n${issues}\n` +
        `See .env.example for the required keys.`,
    );
  }
  return {
    ...parsed.data,
    containerEnvPassthrough: collectContainerEnvPassthrough(process.env),
  };
}

export const env: ServerEnv = parseEnv();
