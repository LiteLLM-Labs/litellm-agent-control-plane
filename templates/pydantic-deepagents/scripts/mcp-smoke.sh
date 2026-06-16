#!/usr/bin/env bash
#
# Smoke-test MCP wiring with DeepWiki. For deterministic local verification,
# run the server with MODEL=test and disable non-MCP built-in tools:
#
#   PYDANTIC_DEEP_TODO=false \
#   PYDANTIC_DEEP_FILESYSTEM=false \
#   PYDANTIC_DEEP_SUBAGENTS=false \
#   PYDANTIC_DEEP_SKILLS=false \
#   PYDANTIC_DEEP_MEMORY=false \
#   PYDANTIC_DEEP_WEB_SEARCH=false \
#   PYDANTIC_DEEP_WEB_FETCH=false \
#   PYDANTIC_DEEP_CONTEXT_MANAGER=false \
#   PYDANTIC_DEEP_COST_TRACKING=false \
#   uvicorn src.server:app --host 0.0.0.0 --port 8080

set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
MODEL="${MODEL:-test}"
DEEPWIKI_MCP_URL="${DEEPWIKI_MCP_URL:-https://mcp.deepwiki.com/mcp}"

HDR=(
  -H "content-type: application/json"
  -H "x-api-key: ${RUNTIME_API_KEY:-smoke}"
  -H "anthropic-version: 2023-06-01"
  -H "anthropic-beta: managed-agents-2026-04-01"
)

json_field() {
  local field="$1"
  python3 -c "import sys,json
d=json.load(sys.stdin)
v=d.get('$field','')
print(v if v is not None else '')"
}

step() { printf '\n=== %s ===\n' "$*"; }

step "1. POST /v1/agents with DeepWiki MCP"
agent_json=$(curl -s "${HDR[@]}" -X POST "$BASE/v1/agents" -d "$(cat <<JSON
{
  "name": "DeepWiki MCP Smoke",
  "model": "$MODEL",
  "system": "Use DeepWiki MCP tools when asked about GitHub repositories.",
  "mcp_servers": [
    {
      "name": "deepwiki",
      "type": "url",
      "url": "$DEEPWIKI_MCP_URL"
    }
  ]
}
JSON
)")
echo "$agent_json"
aid=$(printf '%s' "$agent_json" | json_field id)
if [ -z "${aid:-}" ]; then
  echo "FAIL: no agent id returned from POST /v1/agents" >&2
  exit 1
fi

step "2. POST /v1/sessions"
session_json=$(curl -s "${HDR[@]}" -X POST "$BASE/v1/sessions" -d "$(cat <<JSON
{
  "agent": "$aid",
  "title": "deepwiki-mcp-smoke"
}
JSON
)")
echo "$session_json"
sid=$(printf '%s' "$session_json" | json_field id)
if [ -z "${sid:-}" ]; then
  echo "FAIL: no session id returned from POST /v1/sessions" >&2
  exit 1
fi

step "3. GET /v1/sessions/$sid/events/stream (background SSE)"
sse_tmp="$(mktemp -t pydantic-deepagents-mcp-smoke-sse.XXXXXX)"
curl -sN -H "x-api-key: ${RUNTIME_API_KEY:-smoke}" "$BASE/v1/sessions/$sid/events/stream" \
  | tee "$sse_tmp" >/dev/null &
sse_pid=$!
sleep 1

step "4. POST /v1/sessions/$sid/events"
curl -s "${HDR[@]}" -X POST "$BASE/v1/sessions/$sid/events" -d "$(cat <<'JSON'
{
  "events": [
    {
      "type": "user.message",
      "content": [
        {
          "type": "text",
          "text": "Use DeepWiki MCP to inspect vstorm-co/pydantic-deepagents and answer in one sentence."
        }
      ]
    }
  ]
}
JSON
)"
echo

step "5. captured SSE events"
sleep "${MCP_SMOKE_WAIT_SECONDS:-45}"
kill "$sse_pid" 2>/dev/null || true
wait "$sse_pid" 2>/dev/null || true
if [ -s "$sse_tmp" ]; then
  cat "$sse_tmp"
else
  echo "(no SSE events captured)"
fi

for event in "agent.tool_use" "agent.tool_result" "agent.message" "session.status_idle"; do
  if ! grep -q "$event" "$sse_tmp"; then
    echo "FAIL: no $event event captured" >&2
    rm -f "$sse_tmp"
    exit 1
  fi
done

rm -f "$sse_tmp"

echo
echo "mcp smoke: ok."
