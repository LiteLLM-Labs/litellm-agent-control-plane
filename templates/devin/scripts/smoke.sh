#!/usr/bin/env bash
#
# smoke.sh — smoke-tests the ANTHROPIC MANAGED AGENTS API surface exposed by
# this server (the Devin CLI is the hidden backend, driven over ACP). Exercises
# health, model discovery, agent create/get, environment create, session
# create, an SSE stream, and a user.message round-trip.
#
# Usage:
#   BASE=http://localhost:8080 MODEL=opus ./scripts/smoke.sh
#
# MODEL is the Devin model name selected for the agent (e.g. opus, sonnet, swe,
# gpt, gemini, adaptive). It must be a model your Devin account can use.
#
# NOTE: the prompt round-trip (steps 7-8) only produces real assistant output if
# the SERVER's host has Devin authenticated (via `devin auth login`, or
# WINDSURF_API_KEY). Without it, agent/environment/session creation still
# succeed; the SSE stream just won't carry agent.message parts.

set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
MODEL="${MODEL:-adaptive}"

HDR=(
  -H "content-type: application/json"
  -H "x-api-key: smoke"
  -H "anthropic-version: 2023-06-01"
  -H "anthropic-beta: managed-agents-2026-04-01"
)

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
curl -fsS "$BASE/health"
echo

# ---------------------------------------------------------------------------
# 2. model discovery (mandatory — LAP calls this during agent creation)
# ---------------------------------------------------------------------------
step "2. GET /v1/models"
models_json=$(curl -sf "$BASE/v1/models" -H "content-type: application/json" || echo '{}')
echo "$models_json" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d.get('object') == 'list', 'expected object=list'
ids=[m.get('id') for m in d.get('data', []) if isinstance(m, dict) and m.get('id')]
assert ids, 'no runtime models returned'
print('models:', ', '.join(ids))
" 2>/dev/null || { echo "$models_json"; echo "WARN: model discovery check skipped"; }

# ---------------------------------------------------------------------------
# 3. create an agent
# ---------------------------------------------------------------------------
step "3. POST /v1/agents"
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
# 4. fetch the agent back
# ---------------------------------------------------------------------------
step "4. GET /v1/agents/$aid"
curl -s "${HDR[@]}" "$BASE/v1/agents/$aid"
echo

# ---------------------------------------------------------------------------
# 5. create an environment (tolerate a server that ignores environments)
# ---------------------------------------------------------------------------
step "5. POST /v1/environments"
env_json=$(curl -s "${HDR[@]}" -X POST "$BASE/v1/environments" -d "$(cat <<'JSON'
{ "name": "smoke-env", "config": {} }
JSON
)")
echo "$env_json"
eid=$(printf '%s' "$env_json" | json_field id || true)
echo "environment id: ${eid:-<none>}"

# ---------------------------------------------------------------------------
# 6. create a session bound to the agent (+ environment if we have one)
# ---------------------------------------------------------------------------
step "6. POST /v1/sessions"
session_json=$(curl -s "${HDR[@]}" -X POST "$BASE/v1/sessions" -d "$(cat <<JSON
{ "agent": "$aid", "environment_id": "${eid:-}", "title": "smoke" }
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
# 7. open the SSE stream in the background, tee to a tmp file
# ---------------------------------------------------------------------------
step "7. GET /v1/sessions/$sid/events/stream (background SSE)"
sse_tmp="$(mktemp -t smoke-sse.XXXXXX)"
curl -sN -H "x-api-key: smoke" "$BASE/v1/sessions/$sid/events/stream" > "$sse_tmp" &
sse_pid=$!
sleep 1

# ---------------------------------------------------------------------------
# 8. send a user.message (the prompt round-trip; needs Devin credentials)
# ---------------------------------------------------------------------------
step "8. POST /v1/sessions/$sid/events"
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
# 9. wait for events, stop the stream, print what we captured
# ---------------------------------------------------------------------------
step "9. captured SSE events"
sleep 30
kill "$sse_pid" 2>/dev/null || true
wait "$sse_pid" 2>/dev/null || true
if [ -s "$sse_tmp" ]; then
  cat "$sse_tmp"
else
  echo '(no SSE events captured — is the host authenticated with `devin auth login`?)'
fi
rm -f "$sse_tmp"

echo
echo "smoke: done."
