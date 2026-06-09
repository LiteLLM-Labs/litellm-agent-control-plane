#!/usr/bin/env bash
#
# smoke.sh — smoke-tests the ANTHROPIC MANAGED AGENTS API surface exposed by this
# server (opencode is the hidden backend). Exercises health, agent create/get,
# environment create, session create, an SSE stream, and a user.message round-trip.
#
# Usage:
#   BASE=http://localhost:8080 MODEL=claude-sonnet-4-6 ./scripts/smoke.sh
#
# Make it executable first:  chmod +x scripts/smoke.sh
#
# NOTE: the prompt round-trip (steps 6-8) only produces real assistant output if
# the SERVER's environment has a model provider key (e.g. ANTHROPIC_API_KEY).
# Without it, agent/environment/session creation still succeed; the SSE stream
# just won't carry agent.message parts.

set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
MODEL="${MODEL:-claude-sonnet-4-6}"

# Anthropic Managed Agents headers. The api key is accepted loosely for the demo.
HDR=(
  -H "content-type: application/json"
  -H "x-api-key: smoke"
  -H "anthropic-version: 2023-06-01"
  -H "anthropic-beta: managed-agents-2026-04-01"
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Extract a top-level string field from a JSON document on stdin.
# Prefers python3; falls back to node, then jq.
json_field() {
  local field="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
v=d.get('$field','')
print(v if v is not None else '')" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);process.stdout.write(String(o['$field']??''))}catch(e){}})" 2>/dev/null
  elif command -v jq >/dev/null 2>&1; then
    jq -r --arg f "$field" '.[$f] // empty' 2>/dev/null
  else
    echo "ERROR: need python3, node, or jq to parse JSON" >&2
    return 1
  fi
}

step() { printf '\n=== %s ===\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. health
# ---------------------------------------------------------------------------
step "1. GET /health"
curl -s "$BASE/health"
echo

# ---------------------------------------------------------------------------
# 2. create an agent
# ---------------------------------------------------------------------------
step "2. POST /v1/agents"
agent_json=$(curl -s "${HDR[@]}" -X POST "$BASE/v1/agents" -d "$(cat <<JSON
{
  "name": "Smoke Test",
  "model": "$MODEL",
  "system": "You are terse."
}
JSON
)")
echo "$agent_json"
aid=$(printf '%s' "$agent_json" | json_field id)
if [ -z "${aid:-}" ]; then
  echo "FAIL: no agent id returned from POST /v1/agents" >&2
  exit 1
fi
echo "agent id: $aid"

# ---------------------------------------------------------------------------
# 3. fetch the agent back
# ---------------------------------------------------------------------------
step "3. GET /v1/agents/$aid"
curl -s "${HDR[@]}" "$BASE/v1/agents/$aid"
echo

# ---------------------------------------------------------------------------
# 4. create an environment (tolerate a server that ignores environments)
# ---------------------------------------------------------------------------
step "4. POST /v1/environments"
env_json=$(curl -s "${HDR[@]}" -X POST "$BASE/v1/environments" -d "$(cat <<'JSON'
{
  "name": "smoke-env",
  "config": {}
}
JSON
)")
echo "$env_json"
eid=$(printf '%s' "$env_json" | json_field id || true)
echo "environment id: ${eid:-<none>}"

# ---------------------------------------------------------------------------
# 5. create a session bound to the agent (+ environment if we have one)
# ---------------------------------------------------------------------------
step "5. POST /v1/sessions"
session_json=$(curl -s "${HDR[@]}" -X POST "$BASE/v1/sessions" -d "$(cat <<JSON
{
  "agent": "$aid",
  "environment_id": "${eid:-}",
  "title": "smoke"
}
JSON
)")
echo "$session_json"
sid=$(printf '%s' "$session_json" | json_field id)
if [ -z "${sid:-}" ]; then
  echo "FAIL: no session id returned from POST /v1/sessions" >&2
  exit 1
fi
echo "session id: $sid"

# ---------------------------------------------------------------------------
# 6. open the SSE stream in the background, tee to a tmp file for ~8s
# ---------------------------------------------------------------------------
step "6. GET /v1/sessions/$sid/events/stream (background SSE)"
sse_tmp="$(mktemp -t smoke-sse.XXXXXX)"
curl -sN -H "x-api-key: smoke" "$BASE/v1/sessions/$sid/events/stream" | tee "$sse_tmp" >/dev/null &
sse_pid=$!
sleep 1

# ---------------------------------------------------------------------------
# 7. send a user.message (the prompt round-trip; needs a model key in server env)
# ---------------------------------------------------------------------------
step "7. POST /v1/sessions/$sid/events"
curl -s "${HDR[@]}" -X POST "$BASE/v1/sessions/$sid/events" -d "$(cat <<'JSON'
{
  "events": [
    { "type": "user.message", "content": [ { "type": "text", "text": "Say hello in 3 words." } ] }
  ]
}
JSON
)"
echo

# ---------------------------------------------------------------------------
# 8. wait for events, stop the stream, print what we captured
# ---------------------------------------------------------------------------
step "8. captured SSE events"
sleep 8
kill "$sse_pid" 2>/dev/null || true
wait "$sse_pid" 2>/dev/null || true
if [ -s "$sse_tmp" ]; then
  cat "$sse_tmp"
else
  echo "(no SSE events captured — is a model provider key set in the server env?)"
fi
rm -f "$sse_tmp"

echo
echo "smoke: done."
