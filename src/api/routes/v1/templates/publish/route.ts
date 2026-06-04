import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { assertAuth } from "@/api/auth";
import { HttpError } from "@/api/types";
import { wrap } from "@/api/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFile = promisify(execFileCb);
const TEMPLATE_JSON = "src/agent_templates.json";
const REPO = "LiteLLM-Labs/litellm-agent-platform";

const McpAllowedToolsSchema = z.object({
  server_id: z.string().min(1),
  tools: z.array(z.string().min(1)).default([]),
});

const PublishTemplateSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().optional().default("🤖"),
  tags: z.array(z.string().min(1)).optional().default([]),
  harness_id: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().optional().default(""),
  tools: z.array(z.string().min(1)).optional().default([]),
  mcp_servers: z.array(z.string().min(1)).optional().default([]),
  mcp_allowed_tools: z.array(McpAllowedToolsSchema).optional().default([]),
  env_vars: z.record(z.string(), z.string()).optional().default({}),
  env_var_hosts: z.record(z.string(), z.array(z.string().min(1))).optional().default({}),
  skill_ids: z.array(z.string().min(1)).optional().default([]),
  skill_name: z.string().optional().default(""),
  skill: z.string().optional().default(""),
  pfp_url: z.string().nullable().optional().default(null),
});

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function assertNoSecretValues(envVars: Record<string, string>) {
  const keysWithValues = Object.entries(envVars)
    .filter(([key, value]) => key.trim() && value.trim())
    .map(([key]) => key);
  if (keysWithValues.length > 0) {
    throw new HttpError(
      400,
      `Remove env var values before publishing globally: ${keysWithValues.join(", ")}`,
    );
  }
}

async function run(cwd: string, cmd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFile(cmd, args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim() || stderr.trim();
}

export const POST = wrap(async (req: Request) => {
  assertAuth(req);
  const parsed = PublishTemplateSchema.parse(await req.json());
  assertNoSecretValues(parsed.env_vars);

  const id = slugify(parsed.id || parsed.name);
  if (!id) throw new HttpError(400, "Template id is required.");

  const cwd = process.cwd();
  await run(cwd, "git", ["fetch", "origin", "main", "--prune"]);

  const branch = `codex/publish-template-${id}-${Date.now()}`;
  const worktree = await mkdtemp(join(tmpdir(), "lap-template-publish-"));

  try {
    await run(cwd, "git", ["worktree", "add", "-b", branch, worktree, "refs/remotes/origin/main"]);

    const jsonPath = join(worktree, TEMPLATE_JSON);
    const raw = await readFile(jsonPath, "utf8");
    const templates = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (templates.some((template) => template.id === id)) {
      throw new HttpError(409, `Template '${id}' already exists.`);
    }

    const entry: Record<string, unknown> = {
      id,
      name: parsed.name.trim(),
      description: parsed.description.trim(),
      icon: parsed.icon,
      version: 1,
      tags: parsed.tags,
      harness_id: parsed.harness_id,
      model: parsed.model,
      prompt: parsed.prompt,
      tools: parsed.tools,
      requirements: null,
    };

    if (parsed.mcp_servers.length > 0) entry.mcp_servers = parsed.mcp_servers;
    if (parsed.mcp_allowed_tools.length > 0) entry.mcp_allowed_tools = parsed.mcp_allowed_tools;
    if (Object.keys(parsed.env_vars).length > 0) entry.env_vars = parsed.env_vars;
    if (Object.keys(parsed.env_var_hosts).length > 0) entry.env_var_hosts = parsed.env_var_hosts;
    if (parsed.skill_ids.length > 0) entry.skill_ids = parsed.skill_ids;
    if (parsed.skill.trim()) {
      entry.skill_name = parsed.skill_name.trim() || parsed.name.trim();
      entry.skill = parsed.skill.trim();
    }
    if (parsed.pfp_url) entry.pfp_url = parsed.pfp_url;

    templates.push(entry);
    await writeFile(jsonPath, `${JSON.stringify(templates, null, 2)}\n`);

    await run(worktree, "git", ["config", "user.name", "Codex"]);
    await run(worktree, "git", ["config", "user.email", "codex@local"]);
    await run(worktree, "git", ["add", TEMPLATE_JSON]);
    await run(worktree, "git", ["commit", "-m", `Add ${parsed.name.trim()} agent template`]);
    await run(worktree, "git", ["push", "-u", "origin", branch]);

    const title = `Add ${parsed.name.trim()} agent template`;
    const body = [
      "## Summary",
      `- Add the ${parsed.name.trim()} agent template to the global LAP catalog`,
      "",
      "## Notes",
      "- Created from the Agent Templates publish flow.",
      "- Template starts at version 1.",
    ].join("\n");
    const pullRequestUrl = await run(worktree, "gh", [
      "pr",
      "create",
      "--repo",
      REPO,
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ]);

    return Response.json({
      pull_request_url: pullRequestUrl,
      branch,
      template_id: id,
    });
  } finally {
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
    await run(cwd, "git", ["worktree", "prune"]).catch(() => "");
  }
});
