import { DEFAULT_TIMEZONE } from "@/lib/schedule";
import { INTEGRATIONS } from "@/lib/integrations";
import type { Integration } from "@/lib/integrations";
import type { AgentRuntime } from "@/lib/types";

export interface AgentDraft {
  name: string;
  description: string;
  model: string;
  runtime: string;
  owner_id: string;
  system: string;
  tools: AgentTool[];
  cron: string;
  timezone: string;
  vault_keys: string[];
  skill_ids: string[];
  rule_ids: string[];
  sub_agents: AgentSubAgent[];
  /** IDs of integrations from the resolved MCP catalog to attach as MCP servers. */
  mcp_server_ids: string[];
  max_runtime_minutes: number;
  on_failure: string;
}

export type AgentTool = Record<string, string>;

export interface AgentSubAgent {
  agent_id: string;
}

export interface AgentTemplate {
  id: string;
  title: string;
  description: string;
  tags: string[];
  draft: AgentDraft;
}

export interface ParsedAgentDraft {
  draft: AgentDraft;
  error: string | null;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_RUNTIME = "claude_managed_agents";
const DEFAULT_OWNER = "local";
const DEFAULT_FAILURE = "pause_and_notify";
const DEFAULT_TOOLS: AgentTool[] = [
  { type: "bash" },
  { type: "read" },
  { type: "write" },
  { type: "edit" },
  { type: "glob" },
  { type: "grep" },
  { type: "web_fetch" },
  { type: "web_search" },
];

function baseDraft(): AgentDraft {
  return {
    name: "Untitled Agent",
    description: "A blank starting point with the core toolset.",
    model: DEFAULT_MODEL,
    runtime: DEFAULT_RUNTIME,
    owner_id: DEFAULT_OWNER,
    system:
      "You are a general-purpose agent. Research, write, run commands, and use connected tools to complete the user's task end to end. State assumptions clearly, keep progress visible, and ask for missing credentials only when blocked.",
    tools: DEFAULT_TOOLS.map((tool) => ({ ...tool })),
    cron: "",
    timezone: DEFAULT_TIMEZONE,
    vault_keys: [],
    skill_ids: [],
    rule_ids: [],
    sub_agents: [],
    mcp_server_ids: [],
    max_runtime_minutes: 30,
    on_failure: DEFAULT_FAILURE,
  };
}

export function blankAgentDraft(): AgentDraft {
  return {
    ...baseDraft(),
    tools: DEFAULT_TOOLS.map((tool) => ({ ...tool })),
    vault_keys: [],
    skill_ids: [],
    rule_ids: [],
    sub_agents: [],
    mcp_server_ids: [],
  };
}

export function defaultToolsForRuntime(runtime: string, runtimes: AgentRuntime[]): AgentTool[] {
  const entry = runtimes.find((entry) => entry.id === runtime);
  if (!entry) return DEFAULT_TOOLS.map((tool) => ({ ...tool }));
  return (entry.tools ?? [])
    .filter((tool) => tool.enabled_by_default)
    .map((tool) => ({ type: tool.id }));
}

export function withRuntimeDefaultTools(draft: AgentDraft, runtimes: AgentRuntime[]): AgentDraft {
  return { ...draft, tools: defaultToolsForRuntime(draft.runtime, runtimes) };
}

function withDraft(patch: Partial<AgentDraft>): AgentDraft {
  return {
    ...baseDraft(),
    ...patch,
    tools: (patch.tools ?? DEFAULT_TOOLS).map((tool) => ({ ...tool })),
    vault_keys: [...(patch.vault_keys ?? [])],
    skill_ids: [...(patch.skill_ids ?? [])],
    rule_ids: [...(patch.rule_ids ?? [])],
    sub_agents: [...(patch.sub_agents ?? [])],
    mcp_server_ids: [...(patch.mcp_server_ids ?? [])],
  };
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "blank",
    title: "Blank agent config",
    description: "A neutral base agent with the core toolset.",
    tags: ["core"],
    draft: blankAgentDraft(),
  },
  {
    id: "deep-researcher",
    title: "Deep researcher",
    description: "Synthesizes sources, keeps citations, and writes concise briefs.",
    tags: ["research", "writing"],
    draft: withDraft({
      name: "Deep Researcher",
      description: "Runs multi-step research and writes a sourced synthesis.",
      system:
        "You are a deep research agent. Break broad questions into focused searches, compare sources, preserve source links, call out uncertainty, and write a compact synthesis with clear next steps. Do not invent citations or hide weak evidence.",
      max_runtime_minutes: 45,
    }),
  },
  {
    id: "inbox-triage",
    title: "Inbox triage",
    description: "Categorizes messages, flags urgency, and drafts replies.",
    tags: ["email", "ops"],
    draft: withDraft({
      name: "Inbox Triage Agent",
      description: "Monitors and triages an inbox by priority and response need.",
      system:
        "You are an inbox triage agent. Categorize incoming messages as urgent, needs reply, FYI, or archive. Identify action items, summarize current inbox state, and draft concise reply suggestions for user review. Never send messages or make external changes without explicit approval.",
      vault_keys: ["GMAIL_API_KEY"],
      cron: "0 9 * * 1-5",
    }),
  },
  {
    id: "security-reviewer",
    title: "Security reviewer",
    description: "Reviews code and config for security regressions.",
    tags: ["code", "security"],
    draft: withDraft({
      name: "Security Reviewer",
      description: "Reviews code, dependencies, and configuration for security risk.",
      system:
        "You are a meticulous security reviewer. Inspect code changes, dependency updates, configuration, authentication flows, and data handling. Prioritize exploitable risks, include file-level evidence when available, and separate blocking issues from hardening suggestions.",
      vault_keys: ["GITHUB_TOKEN"],
    }),
  },
  {
    id: "support-agent",
    title: "Support agent",
    description: "Answers customer questions from docs and escalates gaps.",
    tags: ["support", "docs"],
    draft: withDraft({
      name: "Support Agent",
      description: "Answers support questions from product docs and known context.",
      system:
        "You are a support agent. Answer customer questions using the available documentation and product context. Be concise, quote exact limits or steps when known, and escalate when the answer depends on account data, billing, security, or an unverified assumption.",
      vault_keys: ["INTERCOM_ACCESS_TOKEN"],
    }),
  },
  {
    id: "incident-commander",
    title: "Incident commander",
    description: "Triage alerts, open incidents, and maintain status updates.",
    tags: ["on-call", "slack"],
    draft: withDraft({
      name: "Incident Commander",
      description: "Coordinates alert triage, incident notes, and team updates.",
      system:
        "You are an incident commander agent. Triage incoming alerts, collect timeline facts, identify likely owners, draft status updates, and keep an incident checklist current. Ask before paging people, opening tickets, or posting to shared channels unless a human has already approved the action.",
      vault_keys: ["SENTRY_AUTH_TOKEN", "LINEAR_API_KEY", "SLACK_BOT_TOKEN"],
      max_runtime_minutes: 60,
    }),
  },
  {
    id: "data-analyst",
    title: "Data analyst",
    description: "Explores data, checks assumptions, and writes findings.",
    tags: ["data", "analysis"],
    draft: withDraft({
      name: "Data Analyst",
      description: "Loads, explores, and summarizes datasets with reproducible steps.",
      system:
        "You are a data analyst agent. Inspect the dataset shape first, validate assumptions, run reproducible calculations, and explain findings with caveats. Prefer simple tables and charts over long prose when they make the answer clearer.",
      vault_keys: ["DATABASE_URL"],
      max_runtime_minutes: 45,
    }),
  },
  {
    id: "sprint-retro",
    title: "Sprint retro facilitator",
    description: "Summarizes a sprint and drafts retro themes.",
    tags: ["linear", "docs"],
    draft: withDraft({
      name: "Sprint Retro Facilitator",
      description: "Pulls sprint work, synthesizes themes, and drafts a retro note.",
      system:
        "You are a sprint retro facilitator. Review completed work, open carryover, incident notes, and team comments. Summarize what shipped, what slowed the team down, and which follow-ups need owners. Keep the output facilitation-ready and neutral in tone.",
      vault_keys: ["LINEAR_API_KEY", "NOTION_API_KEY"],
      cron: "0 13 * * 5",
    }),
  },
];

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

function cleanRequest(prompt: string): string {
  return prompt
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^(please\s+)?(i\s+want\s+to\s+build|i\s+want\s+to\s+create|i\s+want|i\s+need|can\s+you\s+build|can\s+you\s+create|build|create|make)(\s+me)?\s+/i,
      "",
    )
    .replace(/^(an?|the)\s+agent\s+(that|which|to|for)\s+/i, "")
    .replace(/^agent\s+(that|which|to|for)\s+/i, "")
    .replace(/^(an?|the)\s+/i, "")
    .replace(/\s+(that|which|to|for)\s+.*$/i, "")
    .trim();
}

function requestedName(prompt: string): string {
  const cleaned = cleanRequest(prompt);
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 5);
  const titled = titleCase(words.join(" ")) || "Custom Agent";
  return /\bagent\b/i.test(titled) ? titled : `${titled} Agent`;
}

function sentence(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "Complete the user's requested workflow.";
  return `${compact.charAt(0).toUpperCase()}${compact.slice(1).replace(/[.?!]*$/, ".")}`;
}

export function agentTemplateForPrompt(prompt: string): AgentTemplate {
  const lower = prompt.toLowerCase();
  if (/(inbox|email|gmail|triage|reply)/.test(lower)) return AGENT_TEMPLATES[2];
  if (/(security|vulnerab|auth|permissions|review code|code review)/.test(lower)) return AGENT_TEMPLATES[3];
  if (/(incident|alert|on.?call|sentry|pager|outage)/.test(lower)) return AGENT_TEMPLATES[5];
  if (/(support|customer|ticket|intercom|zendesk|docs? answer)/.test(lower)) return AGENT_TEMPLATES[4];
  if (/(data|dataset|sql|dashboard|report|metric|analytics)/.test(lower)) return AGENT_TEMPLATES[6];
  if (/(retro|sprint|linear|jira|standup)/.test(lower)) return AGENT_TEMPLATES[7];
  if (/(research|brief|summar|scan|monitor|track)/.test(lower)) return AGENT_TEMPLATES[1];
  return AGENT_TEMPLATES[0];
}

function vaultKeysForPrompt(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const keys: string[] = [];
  if (/(github|repo|pull request|code|security)/.test(lower)) keys.push("GITHUB_TOKEN");
  if (/(slack|channel|war room)/.test(lower)) keys.push("SLACK_BOT_TOKEN");
  if (/(linear|issue|sprint|retro)/.test(lower)) keys.push("LINEAR_API_KEY");
  if (/(jira|atlassian)/.test(lower)) keys.push("JIRA_API_TOKEN");
  if (/(sentry|alert|incident|error)/.test(lower)) keys.push("SENTRY_AUTH_TOKEN");
  if (/(gmail|email|inbox)/.test(lower)) keys.push("GMAIL_API_KEY");
  if (/(notion|doc|wiki|retro)/.test(lower)) keys.push("NOTION_API_KEY");
  if (/(intercom|support|customer)/.test(lower)) keys.push("INTERCOM_ACCESS_TOKEN");
  if (/(sql|database|warehouse|dataset|data)/.test(lower)) keys.push("DATABASE_URL");
  return unique(keys);
}

function cronForPrompt(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (/(weekly|every week|retro)/.test(lower)) return "0 9 * * 1";
  if (/(daily|every day|weekday|monitor|scan|report|inbox)/.test(lower)) return "0 9 * * 1-5";
  return "";
}

function subAgentsForPrompt(prompt: string): AgentSubAgent[] {
  void prompt;
  return [];
}

function generatedSystem(template: AgentTemplate, prompt: string): string {
  const objective = sentence(prompt);
  return `${template.draft.system}\n\nUse this agent configuration to accomplish the requested workflow: ${objective} Before taking irreversible external actions, summarize the intended action and wait for explicit user approval. Keep outputs structured, concise, and easy to review.`;
}

export function buildAgentDraftFromPrompt(prompt: string): AgentDraft {
  const promptVaultKeys = vaultKeysForPrompt(prompt);
  const promptCron = cronForPrompt(prompt);
  const promptSubAgents = subAgentsForPrompt(prompt);
  if (/\bhello\s*,?\s*world\b/i.test(prompt)) {
    return {
      ...blankAgentDraft(),
      name: "Hello World Agent",
      description: "A simple agent that greets users with a hello world message.",
      system:
        'You are a friendly Hello World agent. When a user sends you any message, greet them warmly with "Hello, World!" and a brief, cheerful follow-up. Keep responses short, positive, and welcoming.',
      cron: promptCron,
      vault_keys: promptVaultKeys,
      sub_agents: promptSubAgents,
    };
  }

  const template = agentTemplateForPrompt(prompt);
  const request = cleanRequest(prompt) || prompt.trim();
  return {
    ...template.draft,
    name: requestedName(prompt),
    description: sentence(request).replace(/\.$/, ""),
    system: generatedSystem(template, request),
    cron: promptCron || template.draft.cron,
    vault_keys: unique([...template.draft.vault_keys, ...promptVaultKeys]),
    skill_ids: [...template.draft.skill_ids],
    sub_agents: promptSubAgents,
  };
}

function scalar(value: string): string {
  if (!value) return '""';
  if (
    !/[\r\n]/.test(value) &&
    !/:\s/.test(value) &&
    !/\s#/.test(value) &&
    !/\s$/.test(value) &&
    !/^[\s\-\[\]\{\},&*!|>@`]/.test(value) &&
    !/^(true|false|null|undefined)$/i.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function block(value: string): string {
  const lines = value.replace(/\s+$/g, "").split("\n");
  return lines.map((line) => `  ${line}`).join("\n");
}

function listBlock(values: string[]): string {
  if (values.length === 0) return "[]";
  return `\n${values.map((value) => `  - ${scalar(value)}`).join("\n")}`;
}

function toolsBlock(tools: AgentTool[]): string {
  if (tools.length === 0) return "tools: []";
  return [
    "tools:",
    ...tools.flatMap((tool) => {
      const entries = Object.entries(tool);
      if (entries.length === 0) return ["  - {}"];
      const [firstKey, firstValue] = entries[0];
      return [
        `  - ${firstKey}: ${scalar(String(firstValue))}`,
        ...entries.slice(1).map(([key, value]) => `    ${key}: ${scalar(String(value))}`),
      ];
    }),
  ].join("\n");
}

function subAgentsBlock(subAgents: AgentSubAgent[]): string {
  if (subAgents.length === 0) return "sub_agents: []";
  return [
    "sub_agents:",
    ...subAgents.map((agent) => `  - agent_id: ${scalar(agent.agent_id)}`),
  ].join("\n");
}

export function stringifyAgentDraft(draft: AgentDraft): string {
  const lines = [
    `name: ${scalar(draft.name)}`,
    `description: ${scalar(draft.description)}`,
    `model: ${scalar(draft.model)}`,
    `runtime: ${scalar(draft.runtime)}`,
    draft.system.includes("\n")
      ? ["system: |", block(draft.system)].join("\n")
      : `system: ${scalar(draft.system)}`,
    toolsBlock(draft.tools),
  ];

  if (draft.cron.trim()) {
    lines.push("schedule:", `  cron: ${scalar(draft.cron)}`, `  timezone: ${scalar(draft.timezone)}`);
  }
  if (draft.vault_keys.length > 0) lines.push(`vault_keys: ${listBlock(draft.vault_keys)}`);
  if (draft.skill_ids.length > 0) lines.push(`skill_ids: ${listBlock(draft.skill_ids)}`);
  if (draft.rule_ids.length > 0) lines.push(`rule_ids: ${listBlock(draft.rule_ids)}`);
  if (draft.sub_agents.length > 0) lines.push(subAgentsBlock(draft.sub_agents));
  if (draft.mcp_server_ids.length > 0) lines.push(`mcp_servers: ${listBlock(draft.mcp_server_ids)}`);
  if (draft.max_runtime_minutes !== 30) lines.push(`max_runtime_minutes: ${draft.max_runtime_minutes}`);
  if (draft.on_failure !== DEFAULT_FAILURE) lines.push(`on_failure: ${scalar(draft.on_failure)}`);
  return lines.join("\n");
}

function indentOf(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return trimmed.startsWith('"')
        ? JSON.parse(trimmed)
        : trimmed.slice(1, -1).replace(/''/g, "'");
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function inlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]") return [];
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [unquote(trimmed)];
  return unique(
    trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item)),
  );
}

function assignScalar(draft: AgentDraft, key: string, value: string): void {
  const parsed = unquote(value);
  if (key === "name") draft.name = parsed;
  if (key === "description") draft.description = parsed;
  if (key === "model") draft.model = parsed;
  if (key === "runtime") draft.runtime = parsed;
  if (key === "owner_id") draft.owner_id = parsed;
  if (key === "harness") draft.runtime = parsed;
  if (key === "system") draft.system = parsed;
  if (key === "cron") draft.cron = parsed;
  if (key === "timezone") draft.timezone = parsed;
  if (key === "on_failure") draft.on_failure = parsed;
  if (key === "max_runtime_minutes") {
    const next = Number.parseInt(parsed, 10);
    if (Number.isFinite(next)) draft.max_runtime_minutes = next;
  }
}

function parseTools(lines: string[], start: number, draft: AgentDraft): number {
  const tools: AgentTool[] = [];
  let current: AgentTool | null = null;
  let i = start + 1;
  while (i < lines.length) {
    const next = lines[i];
    if (!next.trim()) {
      i += 1;
      continue;
    }
    const indent = indentOf(next);
    if (indent === 0) {
      draft.tools = tools;
      return i - 1;
    }
    const trimmed = next.trim();
    const itemPair = trimmed.match(/^-\s*([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
    if (itemPair) {
      current = {};
      if ((itemPair[2] ?? "").trim()) current[itemPair[1]] = unquote(itemPair[2] ?? "");
      tools.push(current);
      i += 1;
      continue;
    }
    const itemScalar = trimmed.match(/^-\s*(.*)$/);
    if (itemScalar) {
      current = { type: unquote(itemScalar[1]) };
      tools.push(current);
      i += 1;
      continue;
    }
    const pair = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
    if (current && pair && indent <= 4 && (pair[2] ?? "").trim()) {
      current[pair[1]] = unquote(pair[2] ?? "");
    }
    i += 1;
  }
  draft.tools = tools;
  return i - 1;
}

function cleanSubAgents(values: AgentSubAgent[]): AgentSubAgent[] {
  const seen = new Set<string>();
  const agents: AgentSubAgent[] = [];
  values.forEach((agent) => {
    const agentId = agent.agent_id.trim();
    if (!agentId || seen.has(agentId)) return;
    seen.add(agentId);
    agents.push({ agent_id: agentId });
  });
  return agents;
}

function parseSubAgents(lines: string[], start: number, draft: AgentDraft): number {
  const subAgents: AgentSubAgent[] = [];
  let current: AgentSubAgent | null = null;
  let i = start + 1;
  while (i < lines.length) {
    const next = lines[i];
    if (!next.trim()) {
      i += 1;
      continue;
    }
    if (indentOf(next) === 0) {
      draft.sub_agents = cleanSubAgents(subAgents);
      return i - 1;
    }
    const trimmed = next.trim();
    const itemPair = trimmed.match(/^-\s*([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
    if (itemPair) {
      current = { agent_id: itemPair[1] === "agent_id" ? unquote(itemPair[2] ?? "") : "" };
      subAgents.push(current);
      i += 1;
      continue;
    }
    const itemScalar = trimmed.match(/^-\s*(.*)$/);
    if (itemScalar) {
      current = { agent_id: unquote(itemScalar[1]) };
      subAgents.push(current);
      i += 1;
      continue;
    }
    const pair = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
    if (current && pair) {
      const value = unquote(pair[2] ?? "");
      if (pair[1] === "agent_id" || pair[1] === "id") current.agent_id = value;
    }
    i += 1;
  }
  draft.sub_agents = cleanSubAgents(subAgents);
  return i - 1;
}

export function parseAgentDraftConfig(source: string): ParsedAgentDraft {
  const draft = blankAgentDraft();
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || indentOf(line) > 0) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
    if (!match) {
      return { draft, error: `Could not parse line ${i + 1}.` };
    }
    const [, key, raw = ""] = match;
    const value = raw.trim();

    if (key === "system" && value.startsWith("|")) {
      const blockLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() && indentOf(next) === 0) {
          i -= 1;
          break;
        }
        blockLines.push(next.startsWith("  ") ? next.slice(2) : next.trim() ? next : "");
        i += 1;
      }
      draft.system = blockLines.join("\n").trim();
      continue;
    }

    if (key === "schedule") {
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        if (!next.trim()) {
          i += 1;
          continue;
        }
        if (indentOf(next) === 0) {
          i -= 1;
          break;
        }
        const nested = next.trim().match(/^([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
        if (nested) assignScalar(draft, nested[1], nested[2] ?? "");
        i += 1;
      }
      continue;
    }

    if (key === "tools") {
      if (value === "[]") {
        draft.tools = [];
        continue;
      }
      i = parseTools(lines, i, draft);
      continue;
    }

    if (key === "sub_agents" || key === "multiagent") {
      if (value === "[]") {
        draft.sub_agents = [];
        continue;
      }
      i = parseSubAgents(lines, i, draft);
      continue;
    }

    if (key === "vault_keys" || key === "skill_ids" || key === "rule_ids" || key === "mcp_servers") {
      const values = value ? inlineList(value) : [];
      if (!value) {
        i += 1;
        while (i < lines.length) {
          const next = lines[i];
          if (!next.trim()) {
            i += 1;
            continue;
          }
          if (indentOf(next) === 0) {
            i -= 1;
            break;
          }
          const item = next.trim().match(/^-\s*(.*)$/);
          if (item) values.push(unquote(item[1]));
          i += 1;
        }
      }
      if (key === "mcp_servers") {
        draft.mcp_server_ids = unique(values);
      } else {
        draft[key] = unique(values);
      }
      continue;
    }

    assignScalar(draft, key, value);
  }

  if (!draft.name.trim()) return { draft, error: "Agent name is required." };
  if (!draft.model.trim()) return { draft, error: "Model is required." };
  if (!draft.runtime.trim()) return { draft, error: "Runtime is required." };
  return { draft, error: null };
}

export function createInputFromDraft(
  draft: AgentDraft,
  integrations: Integration[] = INTEGRATIONS,
) {
  const cron = draft.cron.trim();
  const runtime = draft.runtime.trim() || DEFAULT_RUNTIME;

  const resolvedMcpServers = draft.mcp_server_ids
    .map((id) => {
      const integration = integrations.find((i) => i.id === id);
      return integration ? { id, type: "url", name: id, url: integration.mcpUrl } : null;
    })
    .filter((s): s is NonNullable<typeof s> => s !== null && s.url.trim().length > 0);
  const mcpServers = resolvedMcpServers.map(({ id: _id, ...rest }) => rest);
  const baseTools = draft.tools.filter((t) => t.type !== "mcp_toolset");
  const mcpToolsets = resolvedMcpServers.map(({ id }) => ({ type: "mcp_toolset", mcp_server_name: id }));
  const allTools = [...baseTools, ...mcpToolsets];
  const subAgents = cleanSubAgents(draft.sub_agents);
  const platformMcpIds = subAgents.length > 0 ? ["run_sub_agent"] : [];

  return {
    name: draft.name.trim(),
    owner_id: draft.owner_id.trim() || DEFAULT_OWNER,
    description: draft.description.trim(),
    model: draft.model.trim() || DEFAULT_MODEL,
    runtime,
    system: draft.system,
    prompt: draft.system,
    tools: allTools,
    mcp_servers: mcpServers,
    schedule: cron ? { cron, timezone: draft.timezone.trim() || "UTC" } : null,
    vault_keys: draft.vault_keys,
    skill_ids: draft.skill_ids,
    rule_ids: draft.rule_ids,
    max_runtime_minutes: draft.max_runtime_minutes,
    on_failure: draft.on_failure.trim() || DEFAULT_FAILURE,
    config: {
      runtime,
      tools: allTools,
      mcp_servers: mcpServers,
      sub_agents: subAgents,
      platform_mcp_ids: platformMcpIds,
    },
  };
}
