/**
 * Shared API helpers for talking to a LiteLLM proxy's managed_agents endpoints.
 *
 * Endpoints used (all under /v1/managed_agents):
 *   GET    /dockerfiles                              — list configured harnesses
 *   GET    /sandbox-templates                        — list templates
 *   GET    /agents                                   — list agents
 *   GET    /agents/{id}                              — one agent
 *   POST   /agents                                   — create agent
 *   POST   /agents/{id}/session                      — spawn session (slow ~50-90s)
 *   GET    /sessions                                 — list sessions, optional ?agent_id
 *   GET    /sessions/{id}                            — one session
 *   DELETE /sessions/{id}                            — terminate session
 *   POST   /sessions/{id}/message                    — passthrough chat message
 *
 * Resolution order:
 *   - Base URL: localStorage("LITELLM_PROXY_URL") || NEXT_PUBLIC_LITELLM_BASE_URL || "http://localhost:4000"
 *   - API key:  localStorage("LITELLM_API_KEY")   || NEXT_PUBLIC_LITELLM_API_KEY   || "sk-1234"
 */

const FALLBACK_PROXY = "http://localhost:4000";
const FALLBACK_KEY = "sk-1234";

export function getProxyBase(): string {
  if (typeof window !== "undefined") {
    const ls = window.localStorage.getItem("LITELLM_PROXY_URL");
    if (ls) return ls;
  }
  return process.env.NEXT_PUBLIC_LITELLM_BASE_URL || FALLBACK_PROXY;
}

export function getApiKey(): string {
  if (typeof window !== "undefined") {
    const ls = window.localStorage.getItem("LITELLM_API_KEY");
    if (ls) return ls;
  }
  return process.env.NEXT_PUBLIC_LITELLM_API_KEY || FALLBACK_KEY;
}

export function buildHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getApiKey()}`,
  };
}

// ---------- Types ----------

export type SessionStatus =
  | "creating"
  | "ready"
  | "failed"
  | "dead"
  | string;

export type TemplateBuildStatus =
  | "pending"
  | "ready"
  | "failed"
  | string;

export interface DockerfileRow {
  id: string;
  container_port: number;
}

export interface TemplateRow {
  id: string;
  name?: string | null;
  dockerfile_id: string;
  container_port: number;
  repo_url: string;
  default_branch: string;
  visibility: string;
  image_uri?: string | null;
  task_def_arn?: string | null;
  build_status: TemplateBuildStatus;
  build_error?: string | null;
}

export interface AgentRow {
  id: string;
  name?: string | null;
  model: string;
  prompt?: string | null;
  template_id: string;
  branch: string;
  pfp_url?: string | null;
  created_at?: string | null;
}

export interface SessionRow {
  id: string;
  agent_id: string;
  sandbox_url?: string | null;
  status: SessionStatus;
  task_arn?: string | null;
  response?: HarnessMessageResponse | null;
  created_at?: string | null;
}

/**
 * Shape returned by the harness when we POST a message. Stored on
 * `SessionRow.response` after a `POST /agents/{id}/session` with an
 * `initial_prompt`, and returned directly from `POST /sessions/{id}/message`.
 *
 * Modeled loosely on opencode's response — the proxy passes it through
 * verbatim, so we keep this permissive.
 */
export interface HarnessMessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface HarnessMessageResponse {
  parts?: HarnessMessagePart[];
  [key: string]: unknown;
}

// ---------- Models / MCP (other proxy endpoints, unchanged) ----------

export interface ModelRow {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
}

export interface McpRow {
  server_id: string;
  server_name?: string;
  alias?: string;
  description?: string;
  url?: string;
  transport?: string;
  status?: string;
}

// ---------- Errors ----------

interface FastApiValidationItem {
  loc: (string | number)[];
  msg: string;
  type: string;
}

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: unknown, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function extractErrorMessage(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const items = detail as FastApiValidationItem[];
    return items
      .map((it) =>
        it && typeof it === "object" && "msg" in it
          ? String(it.msg)
          : JSON.stringify(it),
      )
      .join("; ");
  }
  if (detail && typeof detail === "object") {
    const obj = detail as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.message === "string") return obj.message;
  }
  return `Request failed with status ${status}`;
}

// ---------- Core fetch ----------

/**
 * Static base URL resolved at module load (env var only). For runtime
 * resolution that respects localStorage overrides, call `getProxyBase()`.
 */
export const PROXY_BASE: string =
  process.env.NEXT_PUBLIC_LITELLM_BASE_URL || FALLBACK_PROXY;

export interface ApiInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: ApiInit,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getApiKey()}`,
    ...(init?.headers ?? {}),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${getProxyBase()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: init?.signal,
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" && parsed !== null && "detail" in parsed
        ? (parsed as { detail: unknown }).detail
        : parsed;
    throw new ApiError(
      res.status,
      detail,
      extractErrorMessage(detail, res.status),
    );
  }

  return parsed as T;
}

// ---------- Templates / dockerfiles ----------

export function listDockerfiles(): Promise<DockerfileRow[]> {
  return api<DockerfileRow[]>("GET", "/v1/managed_agents/dockerfiles");
}

export function listTemplates(): Promise<TemplateRow[]> {
  return api<TemplateRow[]>("GET", "/v1/managed_agents/sandbox-templates");
}

// ---------- Agents ----------

export interface CreateAgentRequest {
  name?: string;
  model: string;
  prompt?: string;
  tools?: unknown[];
  template_id: string;
  branch?: string;
  litellm_api_key?: string;
  litellm_api_base?: string;
  pfp_url?: string;
}

export interface UpdateAgentRequest {
  name?: string;
  pfp_url?: string;
}

export function listAgents(): Promise<AgentRow[]> {
  return api<AgentRow[]>("GET", "/v1/managed_agents/agents");
}

export function getAgent(id: string): Promise<AgentRow> {
  return api<AgentRow>(
    "GET",
    `/v1/managed_agents/agents/${encodeURIComponent(id)}`,
  );
}

export function createAgent(req: CreateAgentRequest): Promise<AgentRow> {
  return api<AgentRow>("POST", "/v1/managed_agents/agents", req);
}

export function updateAgent(
  id: string,
  req: UpdateAgentRequest,
): Promise<AgentRow> {
  return api<AgentRow>(
    "PATCH",
    `/v1/managed_agents/agents/${encodeURIComponent(id)}`,
    req,
  );
}

// ---------- Sessions ----------

export interface CreateSessionRequest {
  initial_prompt?: string;
  title?: string;
}

export function listSessions(agentId?: string): Promise<SessionRow[]> {
  const qs = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
  return api<SessionRow[]>("GET", `/v1/managed_agents/sessions${qs}`);
}

export function getSession(id: string): Promise<SessionRow> {
  return api<SessionRow>(
    "GET",
    `/v1/managed_agents/sessions/${encodeURIComponent(id)}`,
  );
}

/**
 * Spawn a session for an agent. This is the slowest call in the system —
 * 50–90s typical. Pass an AbortSignal to cancel in-flight requests on
 * navigation. The proxy provisions a Fargate task, waits for the harness to
 * come up, and (optionally) seeds the conversation with `initial_prompt`.
 */
export function spawnSession(
  agentId: string,
  req: CreateSessionRequest,
  init?: ApiInit,
): Promise<SessionRow> {
  return api<SessionRow>(
    "POST",
    `/v1/managed_agents/agents/${encodeURIComponent(agentId)}/session`,
    req,
    init,
  );
}

export function deleteSession(id: string): Promise<{ id: string; status: string }> {
  return api<{ id: string; status: string }>(
    "DELETE",
    `/v1/managed_agents/sessions/${encodeURIComponent(id)}`,
  );
}

// ---------- Session messages (passthrough to harness) ----------

export interface SendMessageRequest {
  text?: string;
  parts?: HarnessMessagePart[];
}

export function sendMessage(
  sessionId: string,
  req: SendMessageRequest,
  init?: ApiInit,
): Promise<HarnessMessageResponse> {
  return api<HarnessMessageResponse>(
    "POST",
    `/v1/managed_agents/sessions/${encodeURIComponent(sessionId)}/message`,
    req,
    init,
  );
}

// ---------- Models ----------

interface OpenAIModelListResponse {
  data: ModelRow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModelRow(value: unknown): ModelRow | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  const row: ModelRow = { id: value.id };
  if (typeof value.object === "string") row.object = value.object;
  if (typeof value.owned_by === "string") row.owned_by = value.owned_by;
  if (typeof value.created === "number") row.created = value.created;
  return row;
}

export async function listModels(): Promise<ModelRow[]> {
  const raw = await api<OpenAIModelListResponse | unknown>("GET", "/v1/models");
  if (!isRecord(raw)) return [];
  const data = raw.data;
  if (!Array.isArray(data)) return [];
  const rows: ModelRow[] = [];
  for (const item of data) {
    const parsed = parseModelRow(item);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

// ---------- Harness response helpers ----------

/**
 * Best-effort flatten of the harness message response into a single string.
 * Used by the session thread view to display assistant turns without binding
 * to a specific harness's exact part shape.
 */
export function harnessResponseText(
  resp: HarnessMessageResponse | null | undefined,
): string {
  if (!resp) return "";
  const parts = Array.isArray(resp.parts) ? resp.parts : [];
  const out: string[] = [];
  for (const p of parts) {
    if (p && typeof p === "object" && typeof p.text === "string") {
      out.push(p.text);
    }
  }
  return out.join("");
}
