#!/usr/bin/env bash
# opencode harness entrypoint.
# All common setup (vault, git clone, LAP_FILE injection, phase reporting) is
# handled by the shared script. See harnesses/_shared/entrypoint-common.sh.
set -euo pipefail

. /opt/lap/common.sh

: "${LITELLM_DEFAULT_MODEL:?LITELLM_DEFAULT_MODEL required}"

# Normalize base URL: strip trailing slash, ensure /v1 suffix.
BASE="${LITELLM_API_BASE%/}"
case "$BASE" in
  */v1) ;;
  *) BASE="${BASE}/v1" ;;
esac

cd "$REPO_DIR"

# Belt-and-suspenders: ensure .git/config has clean remote (no embedded creds).
if [ -n "${REPO_URL:-}" ]; then
  git remote set-url origin "$REPO_URL" 2>/dev/null || true
fi

# Wire LiteLLM through opencode's native Anthropic adapter, pointed at the
# gateway's Anthropic Messages endpoint (BASE is already normalized to .../v1,
# and @ai-sdk/anthropic POSTs to {baseURL}/messages → .../v1/messages).
#
# Why not @ai-sdk/openai-compatible: that adapter stalls after tool calls with
# OpenAI-compatible gateways like LiteLLM (opencode#14972) — the agent runs a
# tool then goes silent. The Anthropic path doesn't. We keep the provider id
# "litellm" so UI/CLI/Slack model references (providerID:"litellm") still match.
#
# permission: every tool is "allow" or "deny" — never "ask", since headless
# `opencode serve` parks forever on the first "ask" prompt with no UI to approve
# it (opencode#16367). bash + edit are denied so the agent does its work in the
# E2B sandbox (provision/execute) and through MCP tools, not on the shared
# harness host. question is denied too — this agent runs autonomously and must
# not block waiting on a human to answer.
#
# Register every Claude model the gateway serves, not just the boot default, so
# the per-agent model the LAP selects "just works" — opencode rejects any model
# absent from this map (that's the haiku-works / opus-4-7-fails bug).
#
# The whole map is built in ONE jq pass (no shell loop) so it's robust across
# shells, and per-model thinking opts are computed in jq:
#   opus-4-7 -> adaptive thinking (the ONLY format opus-4-7 accepts)
#   other sonnet/opus -> legacy enabled+budget thinking
#   haiku / everything else -> no thinking
# Discovery (GET ${BASE}/models) is best-effort; on any failure we fall back to
# just the boot default so the harness still comes up.
opts_for='
  def opts(id):
    if (id|test("opus-4-7")) then {options:{thinking:{type:"adaptive",display:"summarized"},effort:"high"}}
    elif (id|test("sonnet")) or (id|test("opus")) then {options:{thinking:{type:"enabled",budgetTokens:8000}}}
    else {} end;'
MODELS_JSON=$(
  curl -fsS --max-time 10 -H "Authorization: Bearer ${LITELLM_API_KEY}" "${BASE}/models" 2>/dev/null \
    | jq -c "${opts_for} [ .data[].id | select(test(\"claude|opus|sonnet|haiku\")) ] | unique | map({ (.): opts(.) }) | add // {}" 2>/dev/null \
    || printf '%s' '{}'
)
# Guarantee the boot default is present even if discovery returned nothing.
[ -n "$MODELS_JSON" ] || MODELS_JSON='{}'
MODELS_JSON=$(printf '%s' "$MODELS_JSON" \
  | jq -c "${opts_for} if has(\"${LITELLM_DEFAULT_MODEL}\") then . else . + {\"${LITELLM_DEFAULT_MODEL}\": opts(\"${LITELLM_DEFAULT_MODEL}\")} end")
echo "[entrypoint] registered models: $(printf '%s' "$MODELS_JSON" | jq -r 'keys | join(", ")')"
# Sandbox tools: when E2B is configured, mount the bundled stdio MCP that
# exposes provision/execute (same tool surface as the claude-agent-sdk harness).
# Lives at /opt/lap/opencode-sandbox-mcp with its own node_modules baked in.
# Build the opencode `mcp` object: the E2B sandbox MCP (when E2B_API_KEY is
# set), the LAP memory MCP (when memory env is configured — save_memory /
# search_memory), plus every MCP server the LiteLLM key can access (Linear,
# Slack, GitHub, ...).
# gen-mcp-config.mjs emits JSON and JSON-escapes all values, so keys with
# special characters can't corrupt opencode.json. Failure is non-fatal — it
# emits {} and the harness still boots.
MCP_OBJ=$(node /opt/lap/opencode-sandbox-mcp/gen-mcp-config.mjs 2>/tmp/gen-mcp.err || echo '{}')
[ -z "$MCP_OBJ" ] && MCP_OBJ='{}'
MCP_BLOCK="  \"mcp\": ${MCP_OBJ},"
MCP_NAMES=$(printf '%s' "$MCP_OBJ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(Object.keys(JSON.parse(s)).join(", "))}catch{}})')
echo "[entrypoint] MCP servers wired into opencode: ${MCP_NAMES:-none}"
[ -s /tmp/gen-mcp.err ] && cat /tmp/gen-mcp.err

cat > opencode.json <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
${MCP_BLOCK}
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/anthropic",
      "options": {
        "baseURL": "${BASE}",
        "apiKey": "${LITELLM_API_KEY}"
      },
      "models": ${MODELS_JSON}
    }
  },
  "model": "litellm/${LITELLM_DEFAULT_MODEL}",
  "permission": {
    "edit": "deny",
    "bash": "deny",
    "question": "deny",
    "webfetch": "allow",
    "doom_loop": "allow",
    "external_directory": "allow"
  }
}
EOF

# Tell the agent which MCP servers are available so it doesn't guess from
# training. opencode exposes MCP tools as <server>_<tool> (e.g.
# slack_bot_post_message), mirroring the names listed here.
MCP_NOTE=""
if [ -n "${MCP_NAMES:-}" ]; then
  MCP_NOTE=$'\n\nMCP servers available in this session: '"${MCP_NAMES}"$'. Call their tools with the <server>_<tool> prefix (e.g. slack_bot_post_message).'
fi

if [ -n "${AGENT_PROMPT:-}" ] || [ -n "$MCP_NOTE" ]; then
  mkdir -p .opencode/agent
  cat > .opencode/agent/default.md <<EOF2
---
description: sandbox agent
---
${AGENT_PROMPT:-}${MCP_NOTE}
EOF2
fi

# Hydrate attached skills as ~/.claude/skills/<slug>/SKILL.md so opencode's
# native skill loader discovers them on boot (~/.claude/skills is one of
# opencode's global skill paths) and exposes them through the `skill` tool —
# instead of skills only reaching the agent inlined into AGENT_PROMPT as raw
# text. The platform builds SKILLS_JSON in
# src/server/k8s.ts:buildSkillsJsonForAgent (slug already matches the SKILL.md
# frontmatter `name:`). Empty/unset = no-op (most agents). Failure must not
# block the harness.
if [ -n "${SKILLS_JSON:-}" ]; then
  mkdir -p "$HOME/.claude/skills"
  printf '%s' "$SKILLS_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      try {
        const skills = JSON.parse(raw);
        const fs = require("fs"), path = require("path");
        const root = path.join(process.env.HOME, ".claude", "skills");
        let written = 0;
        for (const { slug, content } of skills) {
          if (!slug || typeof content !== "string") continue;
          // Reject anything that is not a plain slug so a crafted name cant
          // escape the skills dir via path traversal. The leading-alnum anchor
          // also rejects "." and ".." (a bare ".." resolves to the parent dir).
          if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) {
            console.error("[entrypoint] WARNING: skipping skill with invalid slug:", JSON.stringify(slug));
            continue;
          }
          const dir = path.join(root, slug);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "SKILL.md"), content);
          written++;
        }
        console.log("[entrypoint] hydrated " + written + " skill(s)");
      } catch (e) {
        console.error("[entrypoint] WARNING: SKILLS_JSON parse failed:", e.message);
      }
    });
  ' || echo "[entrypoint] WARNING: skill hydration failed; continuing"
fi

echo "[entrypoint] base=${BASE} model=${LITELLM_DEFAULT_MODEL} repo=${REPO_DIR}"

# Inline (shared-server) mode: one opencode serve fronted by the inline adapter,
# which gives each agent its own working directory of skills so per-agent skills
# are loadable on the single shared server. Set by Dockerfile.inline; the
# pod-per-session image leaves it unset and runs opencode serve directly.
if [ "${OPENCODE_SHARED_INLINE:-}" = "1" ]; then
  echo "[entrypoint] booting opencode inline adapter (shared server) on 0.0.0.0:${PORT}"
  exec node /opt/lap/inline-adapter.mjs
fi

echo "[entrypoint] booting opencode serve on 0.0.0.0:${PORT}"
exec opencode serve --hostname 0.0.0.0 --port "$PORT"
