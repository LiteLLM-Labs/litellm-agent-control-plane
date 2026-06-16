import { isBuiltinRuntime, type BuiltinRuntimeId } from "@/lib/types";

export interface RuntimeTemplate {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  repoUrl?: string;
  runtimeAlias: string;
  apiSpec: BuiltinRuntimeId;
}

const DEFAULT_RUNTIME_TEMPLATES_MANIFEST_URL =
  "https://raw.githubusercontent.com/LiteLLM-Labs/litellm-agent-platform/main/templates/manifest.json";

export const RUNTIME_TEMPLATES_MANIFEST_URL =
  process.env.NEXT_PUBLIC_RUNTIME_TEMPLATES_MANIFEST_URL?.trim() ||
  DEFAULT_RUNTIME_TEMPLATES_MANIFEST_URL;

export const RUNTIME_TEMPLATES: RuntimeTemplate[] = [
  {
    id: "deepagents",
    name: "DeepAgents",
    description: "LangChain DeepAgents exposed through the Anthropic Managed Agents API.",
    repoPath: "templates/deepagents",
    repoUrl:
      "https://github.com/LiteLLM-Labs/litellm-agent-platform/tree/main/templates/deepagents",
    runtimeAlias: "deepagents",
    apiSpec: "claude_managed_agents",
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    description: "Nous Research Hermes Agent exposed through the Anthropic Managed Agents API.",
    repoPath: "templates/hermes",
    repoUrl: "https://github.com/LiteLLM-Labs/litellm-agent-platform/tree/main/templates/hermes",
    runtimeAlias: "hermes",
    apiSpec: "claude_managed_agents",
  },
  {
    id: "opencode",
    name: "OpenCode Bridge",
    description: "OpenCode agent server that LAP can register as an Anthropic-compatible runtime.",
    repoPath: "templates/opencode",
    repoUrl:
      "https://github.com/LiteLLM-Labs/litellm-agent-platform/tree/main/templates/opencode",
    runtimeAlias: "opencode-anthropic",
    apiSpec: "claude_managed_agents",
  },
  {
    id: "openclaw",
    name: "OpenClaw Bridge",
    description: "OpenClaw Gateway exposed through the Anthropic Managed Agents API.",
    repoPath: "templates/openclaw",
    repoUrl:
      "https://github.com/LiteLLM-Labs/litellm-agent-platform/tree/main/templates/openclaw",
    runtimeAlias: "openclaw",
    apiSpec: "claude_managed_agents",
  },
];

export function runtimeTemplateIconId(template: Pick<RuntimeTemplate, "id">): string {
  if (template.id === "deepagents") return "langchain";
  if (template.id === "opencode") return "opencode";
  if (template.id === "hermes") return "hermes";
  if (template.id === "openclaw") return "openclaw";
  return template.id;
}

export function runtimeTemplateById(
  id: string | null,
  templates: RuntimeTemplate[] = RUNTIME_TEMPLATES,
): RuntimeTemplate | null {
  if (!id) return null;
  return templates.find((template) => template.id === id) ?? null;
}

export async function fetchRuntimeTemplates(
  manifestUrl = RUNTIME_TEMPLATES_MANIFEST_URL,
): Promise<RuntimeTemplate[]> {
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}: Failed to load runtime templates`);
  const data = (await response.json()) as unknown;
  const templates = parseRuntimeTemplatesManifest(data, manifestUrl);
  if (templates.length === 0) throw new Error("Runtime template manifest did not include templates");
  return templates;
}

function parseRuntimeTemplatesManifest(data: unknown, manifestUrl: string): RuntimeTemplate[] {
  const entries = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.templates)
      ? data.templates
      : [];
  return entries
    .map((entry) => parseRuntimeTemplate(entry, manifestUrl))
    .filter((template): template is RuntimeTemplate => template !== null);
}

function parseRuntimeTemplate(entry: unknown, manifestUrl: string): RuntimeTemplate | null {
  if (!isRecord(entry)) return null;
  const id = text(entry, ["id"]);
  const name = text(entry, ["name"]);
  const description = text(entry, ["description"]);
  const repoPath = text(entry, ["path", "repoPath", "repo_path"]);
  const runtimeAlias = text(entry, ["default_alias", "runtimeAlias", "runtime_alias", "alias"]);
  const apiSpec = text(entry, ["api_spec", "apiSpec"]);
  if (!id || !name || !repoPath || !runtimeAlias || !isBuiltinRuntime(apiSpec)) return null;
  return {
    id,
    name,
    description,
    repoPath,
    repoUrl: text(entry, ["source_url", "repoUrl", "repo_url", "html_url"]) || githubTreeUrl(manifestUrl, repoPath),
    runtimeAlias,
    apiSpec,
  };
}

function text(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function githubTreeUrl(manifestUrl: string, repoPath: string): string {
  try {
    const url = new URL(manifestUrl);
    if (url.hostname !== "raw.githubusercontent.com") return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return "";
    const [owner, repo, ref, ...manifestPath] = parts;
    const manifestDir = manifestPath.slice(0, -1);
    const pathParts = repoPath.split("/").filter(Boolean);
    const manifestPrefix = manifestDir.join("/");
    const cleanPath = pathParts.join("/");
    const fullPath =
      manifestPrefix && cleanPath !== manifestPrefix && !cleanPath.startsWith(`${manifestPrefix}/`)
        ? [...manifestDir, ...pathParts].join("/")
        : cleanPath;
    return `https://github.com/${owner}/${repo}/tree/${ref}/${fullPath}`;
  } catch {
    return "";
  }
}
