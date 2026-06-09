export interface OpencodeSession {
  id: string;
  title?: string;
  agent?: string;
  agent_id?: string;
  runtime?: AgentRuntimeId;
  runtime_agent_ref_id?: string;
  provider_session_id?: string;
  provider_run_id?: string;
  provider_url?: string;
  status?: string;
  environment?: Record<string, unknown>;
  /** @deprecated use agent */
  harness?: string;
  time?: { created: number; updated?: number };
  [k: string]: unknown;
}

export type AgentRuntimeId = string;
export type BuiltinRuntimeId = "claude_managed_agents" | "cursor" | "gemini_antigravity" | "opencode";
export function isBuiltinRuntime(id: string): id is BuiltinRuntimeId {
  return id === "claude_managed_agents" || id === "cursor" || id === "gemini_antigravity" || id === "opencode";
}

export interface AgentRuntimeTool {
  id: string;
  name: string;
  description: string;
  enabled_by_default: boolean;
}

export interface AgentRuntime {
  id: AgentRuntimeId;
  name: string;
  default_api_base: string;
  credential_provider_id: string;
  credential_provider_name: string;
  tools: AgentRuntimeTool[];
  connected: boolean;
  api_base?: string | null;
  masked_api_key?: string | null;
}

export interface RuntimeHarness {
  alias: string;
  api_spec: BuiltinRuntimeId;
  display_name: string;
  api_base: string;
  is_default: boolean;
  connected: boolean;
  masked_api_key?: string | null;
  tools: AgentRuntimeTool[];
}

export function resolveApiSpec(
  alias: string,
  harnesses: RuntimeHarness[],
): BuiltinRuntimeId | null {
  if (alias === "claude_managed_agents" || alias === "cursor" || alias === "gemini_antigravity" || alias === "opencode") {
    return alias as BuiltinRuntimeId;
  }
  // Return null when harnesses haven't loaded yet or alias is unknown — callers
  // must treat null as "spec not yet known" rather than silently routing to a
  // default spec that may be wrong for this alias.
  return harnesses.find((h) => h.alias === alias)?.api_spec ?? null;
}

export interface MessageInfo {
  id?: string;
  role: "user" | "assistant";
  finish?: string;
  tokens?: { input?: number; output?: number; reasoning?: number };
  time?: { created?: number; completed?: number };
  providerID?: string;
  modelID?: string;
  sessionID?: string;
  [k: string]: unknown;
}

interface PartBase {
  id?: string;
  messageID?: string;
  sessionID?: string;
}

export type HarnessMessagePart = PartBase &
  (
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string; time?: { start?: number; end?: number } }
    | { type: "thinking"; text: string; time?: { start?: number; end?: number } }
    | {
        type: "tool";
        tool: string;
        state: {
          status: string;
          input?: unknown;
          output?: unknown;
          error?: unknown;
          [k: string]: unknown;
        };
      }
    | { type: "step-start" }
    | { type: "step-finish"; [k: string]: unknown }
  );

export interface HarnessMessage {
  info: MessageInfo;
  parts: HarnessMessagePart[];
}

export interface Agent {
  id: string;
  name: string;
  model?: string;
  prompt?: string;
  system?: string;
  description?: string;
  harness?: string;
  cron?: string | null;
  timezone?: string | null;
  status?: string;
  owner_id?: string | null;
  /** IDs of DB-backed skills attached to this agent (agents.skill_ids). */
  skill_ids?: string[];
  /** IDs of DB-backed rules attached to this agent (agents.rule_ids). */
  rule_ids?: string[];
  vault_keys?: string[];
  config?: Record<string, unknown>;
  created_at?: number;
  [k: string]: unknown;
}

export interface PlatformMcp {
  id: string;
  name: string;
  description: string;
}

export interface Routine {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  status: "active" | "paused" | string;
  last_run_id?: string | null;
  last_run_at?: number | null;
  created_at: number;
  updated_at: number;
}

export interface AgentFile {
  agent_id: string;
  path: string;
  encoding?: "utf8" | "base64" | string;
  size_bytes: number;
  created_at: number;
  updated_at: number;
}

export interface AgentRunStart {
  run_id: string;
  agent_id: string;
  status: string;
  event_url: string;
}

export interface VaultKeyEntry {
  key: string;
  scope: "global" | "personal";
  updated_at?: number;
  /** "env" if sourced from environment variables */
  source?: string;
}

/** A reusable, DB-backed skill (capability doc) attachable to an agent. */
export interface Skill {
  id: string;
  name: string;
  description: string | null;
  content: string;
  owner_id: string | null;
  created_at: number;
}

/** A reusable, DB-backed Markdown rule attachable to an agent. */
export interface Rule {
  id: string;
  name: string;
  description: string | null;
  content: string;
  owner_id: string | null;
  created_at: number;
  updated_at: number;
}

/** A durable key→value note an agent has stored in its memory. */
export interface Memory {
  id: string;
  agent_id: string;
  key: string;
  value: string;
  always_on?: boolean | number;
  created_at: number;
  updated_at: number;
}

export interface McpServer {
  server_id: string;
  server_name?: string | null;
  alias?: string | null;
  description?: string | null;
  instructions?: string | null;
  url?: string | null;
  transport: string;
  auth_type?: string | null;
  is_byok: boolean;
  byok_description?: string[];
  byok_api_key_help_url?: string | null;
  allowed_tools?: string[];
  available_on_public_internet: boolean;
  approval_status?: string | null;
  status?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  [k: string]: unknown;
}

export interface SpendLog {
  request_id: string;
  call_type: string;
  api_key: string;
  spend: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  start_time: string;
  end_time: string;
  request_duration_ms: number | null;
  model: string;
  model_id: string | null;
  model_group: string | null;
  custom_llm_provider: string | null;
  api_base: string | null;
  user: string | null;
  metadata: Record<string, unknown> | null;
  cache_hit: string | null;
  cache_key: string | null;
  request_tags: unknown[] | Record<string, unknown> | null;
  end_user: string | null;
  requester_ip_address: string | null;
  messages: unknown;
  response: unknown;
  session_id: string | null;
  status: string | null;
}
