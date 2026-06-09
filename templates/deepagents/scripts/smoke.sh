#!/usr/bin/env bash
#
# Smoke-test the Anthropic Managed Agents API surface exposed by the
# DeepAgents template server.

set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
MODEL="${MODEL:-anthropic:claude-sonnet-4-5}"

HDR=(
  -H "content-type: application/json"
  -H "x-api-key: ${RUNTIME_API_KEY:-smoke}"
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

step "1. GET /health"
curl -s "$BASE/health"
echo

step "2. POST /v1/agents"
agent_json=$(curl -s "${HDR[@]}" -X POST "$BASE/v1/agents" -d "$(cat <<JSON
{
  "name": "Smoke Test",
  "model": "$MODEL",
  "system": "You have tools. When asked to call tools, call them before answering."
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

step "3. GET /v1/agents/$aid"
curl -s "${HDR[@]}" "$BASE/v1/agents/$aid"
echo

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

step "6. GET /v1/sessions/$sid/events/stream (background SSE)"
sse_tmp="$(mktemp -t deepagents-smoke-sse.XXXXXX)"
curl -sN -H "x-api-key: ${RUNTIME_API_KEY:-smoke}" "$BASE/v1/sessions/$sid/events/stream" | tee "$sse_tmp" >/dev/null &
sse_pid=$!
sleep 1

step "7. POST /v1/sessions/$sid/events"
first_send=$(curl -s "${HDR[@]}" -X POST "$BASE/v1/sessions/$sid/events" -d "$(cat <<'JSON'
{
  "events": [
    { "type": "user.message", "content": [ { "type": "text", "text": "Call the ls tool on . and the glob tool for *.md. Then summarize briefly." } ] }
  ]
}
JSON
)")
echo "$first_send"

step "8. POST /v1/sessions/$sid/events while first turn is running"
second_send=$(curl -s "${HDR[@]}" -X POST "$BASE/v1/sessions/$sid/events" -d "$(cat <<'JSON'
{
  "events": [
    { "type": "user.message", "content": [ { "type": "text", "text": "Say queued follow-up received." } ] }
  ]
}
JSON
)")
echo "$second_send"
if ! printf '%s' "$second_send" | grep -q '"queued":true'; then
  echo "FAIL: second send was not queued while session was running" >&2
  kill "$sse_pid" 2>/dev/null || true
  rm -f "$sse_tmp"
  exit 1
fi

step "9. captured SSE events"
sleep "${SMOKE_WAIT_SECONDS:-45}"
kill "$sse_pid" 2>/dev/null || true
wait "$sse_pid" 2>/dev/null || true
if [ -s "$sse_tmp" ]; then
  cat "$sse_tmp"
else
  echo "(no SSE events captured)"
fi

if ! grep -q "agent.message" "$sse_tmp"; then
  echo "FAIL: no agent.message event captured" >&2
  rm -f "$sse_tmp"
  exit 1
fi
if ! grep -q "agent.tool_use" "$sse_tmp"; then
  echo "FAIL: no agent.tool_use event captured" >&2
  rm -f "$sse_tmp"
  exit 1
fi
if ! grep -q "agent.tool_result" "$sse_tmp"; then
  echo "FAIL: no agent.tool_result event captured" >&2
  rm -f "$sse_tmp"
  exit 1
fi
if ! grep -q "session.status_idle" "$sse_tmp"; then
  echo "FAIL: no session.status_idle event captured" >&2
  rm -f "$sse_tmp"
  exit 1
fi
rm -f "$sse_tmp"

echo
echo "smoke: ok."
