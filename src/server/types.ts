/**
 * Shared backend contract.
 *
 * Every src/server/*.ts module and every route handler imports from this
 * file. The fan-out implementation rule: don't change a function name,
 * argument name, or return type defined here. If you need to, stop and
 * amend types.ts first, then re-fan-out.
 *
 * The Prisma row types (Agent, Session) are re-exported from @prisma/client
 * — that's the canonical shape. API request/response shapes are the wire
 * contract with src/lib/api.ts (frontend) and must stay drop-in compatible
 * with what the existing UI sends.
 */

import type { Agent, Session } from "@prisma/client";
import { z } from "zod";

// ============================================================================
// DB row types (re-export from Prisma, do not redefine)
// ============================================================================

export type AgentRow = Agent;
export type SessionRow = Session;

export type SessionStatus = "creating" | "ready" | "failed" | "dead";

// ============================================================================
// API request schemas (zod) — handlers parse with these
// ============================================================================

export const CreateAgentBody = z.object({
  name: z.string().optional(),
  model: z.string().min(1),
  prompt: z.string().optional(),
  tools: z.array(z.unknown()).default([]),
  repo_url: z.string().url().optional(),
  branch: z.string().optional(),
  pfp_url: z.string().optional(),
  mcp_servers: z.array(z.string()).default([]),
});
export type CreateAgentBody = z.infer<typeof CreateAgentBody>;

export const UpdateAgentBody = z.object({
  name: z.string().optional(),
  pfp_url: z.string().optional(),
  mcp_servers: z.array(z.string()).optional(),
});
export type UpdateAgentBody = z.infer<typeof UpdateAgentBody>;

export const CreateSessionBody = z.object({
  initial_prompt: z.string().optional(),
  title: z.string().optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;

export const SendMessageBody = z.object({
  text: z.string().optional(),
  parts: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type SendMessageBody = z.infer<typeof SendMessageBody>;

// ============================================================================
// API response shapes — keep field names identical to frontend src/lib/api.ts
// (drop-in compatibility). `id` aliases the Prisma PK; `created_at` is ISO.
// ============================================================================

export interface ApiAgent {
  id: string;
  name: string | null;
  model: string;
  prompt: string | null;
  harness_id: string;
  repo_url: string | null;
  branch: string;
  pfp_url: string | null;
  mcp_servers: string[];
  created_at: string;
}

export interface ApiSession {
  id: string;
  agent_id: string;
  sandbox_url: string | null;
  status: SessionStatus | string;
  task_arn: string | null;
  response: HarnessMessageResponse | null;
  created_at: string;
}

export interface ApiDockerfile {
  id: string;
  container_port: number;
}

export interface HarnessMessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface HarnessMessageResponse {
  parts?: HarnessMessagePart[];
  [key: string]: unknown;
}

/**
 * One entry from opencode's `GET /session/:id/message`. Each user prompt may
 * spawn multiple assistant messages within the agent loop (tool call, then
 * text reply, etc.) — POST /session/:id/message returns only the final one,
 * so to render reasoning + tool parts the UI has to read the full list.
 */
export interface HarnessMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | string;
  [key: string]: unknown;
}

export interface HarnessMessage {
  info: HarnessMessageInfo;
  parts: HarnessMessagePart[];
}

// ============================================================================
// Module signatures — fan-out agents implement against these.
// ============================================================================

// ---- src/server/env.ts ----
export interface ServerEnv {
  DATABASE_URL: string;
  UI_USERNAME: string;
  MASTER_KEY: string;
  AWS_REGION: string;
  AWS_CLUSTER: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_PROFILE?: string;
  AWS_TASK_DEFINITION_ARN: string;
  AWS_SUBNETS: string[]; // parsed from comma-separated env
  AWS_SECURITY_GROUP: string;
  PREINSTALLED_GITHUB_REPO: string;
  LITELLM_API_BASE: string;
  LITELLM_API_KEY: string;
  CONTAINER_PORT: number; // default 4096
  RECONCILE_INTERVAL_SECONDS: number; // default 60
  /**
   * All process.env entries whose key starts with `CONTAINER_ENV_`, with
   * the prefix stripped. Passed verbatim into every Fargate container's
   * `environment[]` overrides at RunTask time.
   */
  containerEnvPassthrough: Record<string, string>;
}
// must export: `export const env: ServerEnv`

// ---- src/server/db.ts ----
// must export: `export const prisma: PrismaClient` (HMR-safe singleton)

// ---- src/server/auth.ts ----
/**
 * Bearer auth: header is `Authorization: Bearer <MASTER_KEY>`. UI collects
 * the key at /login and stashes it in localStorage. Constant-time compare
 * against `env.MASTER_KEY`.
 *
 * On miss, throws a Response (401). On hit, returns a stable user_id used
 * for the `created_by` audit column — currently fixed to "ui" since v0 is
 * single-tenant.
 */
export type AuthIdentity = { user_id: string };

// must export:
//   export function assertAuth(req: Request): AuthIdentity
//   export function expectedBearer(): string  // for tests / debugging

// ---- src/server/harness.ts ----
export interface HarnessCreateSessionOpts {
  sandbox_url: string; // http://<task_ip>:<container_port>
  title?: string;
  timeout_ms?: number;
}

export interface HarnessSendMessageOpts {
  sandbox_url: string;
  harness_session_id: string;
  model: string;
  parts: HarnessMessagePart[];
  timeout_ms?: number;
}

// must export:
//   export function expandMessage(text?: string, parts?: HarnessMessagePart[]): HarnessMessagePart[]
//   export async function harnessCreateSession(opts: HarnessCreateSessionOpts): Promise<string> // returns harness_session_id
//   export async function harnessSendMessage(opts: HarnessSendMessageOpts): Promise<HarnessMessageResponse>

// ---- src/server/fargate.ts ----
export interface RunTaskOpts {
  agent: AgentRow;
  session_id: string;
}

export interface TaggedTask {
  task_arn: string;
  session_id: string | null;
  agent_id: string | null;
  last_status: string; // RUNNING | STOPPED | PROVISIONING | etc
  started_at: Date | null;
}

// must export (every function async):
//   export async function runTask(opts: RunTaskOpts): Promise<{ task_arn: string }>
//   export async function stopTask(task_arn: string, reason?: string): Promise<void>
//   export async function waitRunningGetIp(task_arn: string, timeout_ms?: number): Promise<string>  // public IP
//   export async function waitHttpReady(sandbox_url: string, timeout_ms?: number): Promise<void>
//   export async function listTaggedTasks(): Promise<TaggedTask[]>

// ---- src/server/reconcile.ts ----
export interface ReconcileResult {
  inspected: number;
  stopped: number;
  failed_creating: number;
  idle_killed: number;
}

// must export:
//   export async function reconcileOrphans(): Promise<ReconcileResult>
//   export async function stopSessionsForAgent(agent_id: string): Promise<number>

// ============================================================================
// HTTP error helper used by every route handler
// ============================================================================

export class HttpError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

export function httpError(status: number, detail: unknown): never {
  throw new HttpError(status, detail);
}

// ============================================================================
// Row → API mappers (one source of truth so all handlers agree)
// ============================================================================

export function toApiAgent(row: AgentRow): ApiAgent {
  return {
    id: row.agent_id,
    name: row.agent_name ?? null,
    model: row.model,
    prompt: row.prompt ?? null,
    harness_id: row.harness_id,
    repo_url: row.repo_url ?? null,
    branch: row.branch,
    pfp_url: row.pfp_url ?? null,
    mcp_servers: Array.isArray(row.mcp_servers)
      ? (row.mcp_servers as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [],
    created_at: row.created_at.toISOString(),
  };
}

export function toApiSession(
  row: SessionRow,
  response: HarnessMessageResponse | null = null,
): ApiSession {
  return {
    id: row.session_id,
    agent_id: row.agent_id,
    sandbox_url: row.sandbox_url ?? null,
    status: row.status,
    task_arn: row.task_arn ?? null,
    response:
      response ??
      (row.response && typeof row.response === "object"
        ? (row.response as HarnessMessageResponse)
        : null),
    created_at: row.created_at.toISOString(),
  };
}

// ============================================================================
// Constants
// ============================================================================

export const TAG_SESSION_ID = "litellm_session_id";
export const TAG_AGENT_ID = "litellm_agent_id";
export const HARNESS_OPENCODE = "opencode";
export const SESSION_CREATING_TIMEOUT_MS = 600_000;
// Ready sessions with no message activity (last_seen_at) older than this are
// reaped by the reconciler — keeps Fargate cost bounded for forgotten tabs.
export const SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const RECONCILE_NEW_TASK_GRACE_MS = 300_000;
