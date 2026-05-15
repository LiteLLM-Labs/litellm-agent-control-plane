/**
 * Agent template loader.
 *
 * Single source of truth: agent_templates.json at the repo root.
 *
 * Templates with a "files" array reference files stored under
 * agent-templates/<id>/<template_path>. Those files are base64-encoded
 * into LAP_FILE_N_DEST / LAP_FILE_N_CONTENT env vars at load time;
 * the harness entrypoint decodes and writes them to sandbox_path before
 * exec'ing the server.
 *
 * Entries with id starting with "_" are skipped (use for docs/examples).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface TemplateFile {
  template_path: string;
  sandbox_path: string;
  /** Decoded file content — for UI preview only, not sent to the agent. */
  content: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  tags: string[];
  harness_id: string;
  model: string;
  prompt: string;
  skill_name: string;
  skill: string;
  tools: string[];
  requirements: string | null;
  /** Pre-seeded env vars merged into the agent on create (includes encoded files). */
  env_vars: Record<string, string>;
  /** Files to copy into the sandbox — for UI display only. */
  files: TemplateFile[];
}

interface RawTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  tags?: string[];
  harness_id: string;
  model: string;
  prompt?: string;
  /** Path to a Claude Code-format skill .md (relative to agent-templates/<id>/). */
  skill_file?: string;
  skill_name?: string;
  skill?: string;
  tools?: string[];
  requirements?: string | null;
  env_vars?: Record<string, string>;
  files?: Omit<TemplateFile, "content">[];
}

const ROOT = process.cwd();
const JSON_FILE = join(ROOT, "agent_templates.json");
const FILES_DIR = join(ROOT, "agent-templates");

function resolveFiles(id: string, rawFiles: Omit<TemplateFile, "content">[]): {
  files: TemplateFile[];
  env_vars: Record<string, string>;
} {
  const base = join(FILES_DIR, id);
  const files: TemplateFile[] = [];
  const env_vars: Record<string, string> = {};
  rawFiles.forEach(({ template_path, sandbox_path }, i) => {
    try {
      const buf = readFileSync(join(base, template_path));
      files.push({ template_path, sandbox_path, content: buf.toString("utf8") });
      env_vars[`LAP_FILE_${i}_DEST`] = sandbox_path;
      env_vars[`LAP_FILE_${i}_CONTENT`] = buf.toString("base64");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[templates] ${id}/${template_path}: ${msg}`);
    }
  });
  return { files, env_vars };
}

function parseSkillFile(id: string, skillFile: string): { skill_name: string; skill: string } {
  try {
    const text = readFileSync(join(FILES_DIR, id, skillFile), "utf8").trim();
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!m) return { skill_name: "", skill: text };
    const name = m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
    return { skill_name: name, skill: m[2].trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[templates] ${id}/${skillFile}: ${msg}`);
    return { skill_name: "", skill: "" };
  }
}

function fromRaw(raw: RawTemplate): AgentTemplate {
  const { files, env_vars: fileVars } = raw.files?.length
    ? resolveFiles(raw.id, raw.files)
    : { files: [], env_vars: {} };
  const { skill_name, skill } = raw.skill_file
    ? parseSkillFile(raw.id, raw.skill_file)
    : { skill_name: raw.skill_name ?? "", skill: raw.skill ?? "" };
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    icon: raw.icon,
    tags: raw.tags ?? [],
    harness_id: raw.harness_id,
    model: raw.model,
    prompt: raw.prompt ?? "",
    skill_name,
    skill,
    tools: raw.tools ?? [],
    requirements: raw.requirements ?? null,
    env_vars: { ...raw.env_vars, ...fileVars },
    files,
  };
}

function loadTemplates(): AgentTemplate[] {
  try {
    const raw: RawTemplate[] = JSON.parse(readFileSync(JSON_FILE, "utf8"));
    return raw.filter((t) => !t.id.startsWith("_")).map(fromRaw);
  } catch {
    return [];
  }
}

const TEMPLATES: AgentTemplate[] = loadTemplates();

export function listTemplates(): AgentTemplate[] {
  return TEMPLATES;
}

export function getTemplate(id: string): AgentTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
