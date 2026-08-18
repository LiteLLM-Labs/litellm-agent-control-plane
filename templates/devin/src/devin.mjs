// devin.mjs — Devin-specific runtime helpers for the agent server.
//
// Responsibilities:
//   - provision an LAP agent as a Devin always-on rule file (.devin/rules/<id>.mdc)
//   - map LAP mcp_servers entries to ACP mcpServers for session/new
//   - discover models via `devin models list --format json` (with local fallback)
//   - idempotent git init so Devin treats WORKDIR as a project root
//
// Unlike the opencode template, Devin needs NO child reboot on agent change:
// `devin acp` is stateless w.r.t. agents — sessions are created on demand via
// session/new, and rules are read from the workspace per session.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Serialize all rule-file writes so concurrent agent registrations don't race.
let _lock = Promise.resolve();
function withLock(fn) {
  const next = _lock.then(fn, fn);
  _lock = next.then(() => {}, () => {});
  return next;
}

// Devin only treats a directory as a project (and loads .devin/ rules) when it
// is a git repo. Initialise one idempotently. If git is unavailable or the
// workspace can't be initialized, warn loudly — Devin won't load agent rules
// without a git repo, but the server can still start and serve health/models.
export async function gitInit(cwd) {
  await mkdir(cwd, { recursive: true });
  try {
    await execFileP("git", ["init", "-q"], { cwd });
  } catch (e) {
    console.warn("[git] git init failed — Devin rules will not load:", e?.message || e);
    return;
  }
  // Config and the initial commit are non-fatal if they fail (e.g. existing repo).
  const optional = (args) => execFileP("git", args, { cwd }).catch(() => {});
  await optional(["config", "user.email", "agent-server@local"]);
  await optional(["config", "user.name", "agent-server"]);
  await optional(["commit", "-q", "--allow-empty", "-m", "init"]);
}

// Write an LAP agent's system prompt as a Devin always-on rule so it applies to
// every session created for that agent. Devin reads .devin/rules/*.mdc as
// persistent context; the frontmatter `alwaysApply: true` makes it standing.
export async function provisionRule(cwd, agent) {
  if (!agent) return;
  const rulesDir = path.join(cwd, ".devin", "rules");
  await mkdir(rulesDir, { recursive: true });
  const body = (agent.system || "").trim();
  const file = path.join(rulesDir, `${agent.id}.mdc`);
  if (!body) {
    // No system prompt: remove any stale rule for this agent.
    // Serialize with writes to prevent out-of-order clear/restore races.
    await withLock(() => rm(file, { force: true }));
    return;
  }
  const frontmatter = [
    "---",
    "description: LAP agent system prompt",
    "alwaysApply: true",
    "---",
  ].join("\n");
  await withLock(() => writeFile(file, `${frontmatter}\n${body}\n`, "utf8"));
}

export async function removeRule(cwd, agentId) {
  const file = path.join(cwd, ".devin", "rules", `${agentId}.mdc`);
  await rm(file, { force: true });
}

// Re-provision rules for every stored agent into the (ephemeral) workdir. The
// SQLite DB lives on a persistent volume but .devin/ lives in WORKDIR, which is
// wiped on pod restart — without this, sessions bound to stored agent ids would
// lose their system-prompt rules after a restart.
export async function reprovisionRules(cwd, agents, provisionFn = provisionRule) {
  for (const row of agents || []) {
    await provisionFn(cwd, row);
  }
}

// Map an LAP agent's mcp_servers entries to ACP mcpServers for session/new.
// LAP entries: { name, command?, args?, url?, env? }.
// ACP stdio:   { name, command, args, env }
// ACP http:    { name, type: "http", url }
export function toAcpMcpServers(mcpServers) {
  const out = [];
  for (const s of mcpServers || []) {
    if (!s || !s.name) continue;
    if (s.url) {
      out.push({ name: s.name, type: "http", url: s.url });
    } else if (s.command) {
      out.push({
        name: s.name,
        command: s.command,
        args: Array.isArray(s.args) ? s.args : [],
        env: Array.isArray(s.env) ? s.env : [],
      });
    }
  }
  return out;
}

// Default model fallback when no DEVIN_MODEL and no discovery available.
const DEFAULT_MODEL = process.env.DEVIN_DEFAULT_MODEL || "adaptive";

// Discover models from `devin models list --format json`. Returns an OpenAI-
// shaped model list. Falls back to a single default entry on any failure so
// the endpoint always returns 200 during boot.
//
// The real Devin output shape is:
//   { families: [{ family_uid, aliases: ["opus"], variants: [{ model_uid, ... }] }] }
// We surface both aliases (fuzzy names like "opus") and variant model_uids
// (specific IDs like "claude-opus-5-medium"), deduplicated, aliases first.
export async function listDevinModels({ binary = "devin", ownedBy = "devin" } = {}) {
  let families = null;
  try {
    const { stdout } = await execFileP(binary, ["models", "list", "--format", "json"], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const raw = JSON.parse(stdout || "{}");
    families = Array.isArray(raw?.families) ? raw.families : null;
  } catch (e) {
    console.warn("[models] devin models list failed:", e?.message || e);
  }

  const data = [];
  const seen = new Set();
  const add = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    data.push({ id, object: "model", created: 0, owned_by: ownedBy });
  };

  if (families) {
    for (const fam of families) {
      try {
        for (const alias of fam.aliases || []) add(alias);
        for (const v of fam.variants || []) add(v.model_uid);
      } catch (e) {
        // Skip a single malformed family rather than aborting the whole loop.
        console.warn("[models] skipping malformed family:", e?.message || e);
      }
    }
  }
  if (!data.length) {
    add(DEFAULT_MODEL);
  }
  return { object: "list", data };
}
