/**
 * Parses process.env into the locked ServerEnv contract from types.ts.
 *
 * Validation is lazy — triggered on first property access, not on import.
 * `next build` evaluates route modules to collect page data without the
 * runtime .env in scope, so eager parsing made the build fail with
 * "Invalid server environment configuration". Lazy parsing keeps the same
 * fail-fast guarantee at runtime (first request) while letting builds
 * succeed in CI / Docker without secrets baked in.
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
  // Credentials are resolved by the SDK's default provider chain at runtime,
  // not parsed here. Set whatever the chain understands: env vars,
  // AWS_PROFILE + ~/.aws/credentials, SSO, instance role.
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_PROFILE: z.string().optional(),
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

let _env: ServerEnv | null = null;

function getEnv(): ServerEnv {
  if (_env === null) _env = parseEnv();
  return _env;
}

// Proxy makes every `env.FOO` access trigger parseEnv on first read. After
// that, subsequent accesses hit the cached object directly. Property writes
// are blocked — env should be treated as immutable runtime config.
export const env: ServerEnv = new Proxy({} as ServerEnv, {
  get(_target, prop) {
    return getEnv()[prop as keyof ServerEnv];
  },
  has(_target, prop) {
    return prop in getEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(getEnv());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(getEnv(), prop);
  },
});
