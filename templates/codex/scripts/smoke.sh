#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
MODEL="${MODEL:-gpt-5.6-sol-high}"
RUNTIME_API_KEY="${RUNTIME_API_KEY:-smoke}"
HDR=(-H "content-type: application/json" -H "x-api-key: $RUNTIME_API_KEY" -H "anthropic-version: 2023-06-01" -H "anthropic-beta: managed-agents-2026-04-01")

field() {
  local name="$1"
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);process.stdout.write(String(o['$name']??''))})"
}

echo "1. health"
curl -fsS "$BASE/health"

echo "2. model discovery"
models="$(curl -fsS "${HDR[@]}" "$BASE/v1/models")"
printf '%s' "$models" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s).data||[];if(!d.some(x=>x.id===process.argv[1]))process.exit(1)})" "$MODEL"

echo "3. agent CRUD"
agent="$(curl -fsS "${HDR[@]}" -X POST "$BASE/v1/agents" --data "{\"name\":\"Codex smoke\",\"model\":\"$MODEL\",\"system\":\"Reply with exactly: CODEX BRIDGE OK\"}")"
agent_id="$(printf '%s' "$agent" | field id)"
curl -fsS "${HDR[@]}" "$BASE/v1/agents/$agent_id" >/dev/null
curl -fsS "${HDR[@]}" -X PATCH "$BASE/v1/agents/$agent_id" --data '{"name":"Codex smoke updated"}' >/dev/null
curl -fsS "${HDR[@]}" "$BASE/v1/agents" >/dev/null

echo "4. environment and session"
environment="$(curl -fsS "${HDR[@]}" -X POST "$BASE/v1/environments" --data '{"name":"smoke","config":{}}')"
environment_id="$(printf '%s' "$environment" | field id)"
session="$(curl -fsS "${HDR[@]}" -X POST "$BASE/v1/sessions" --data "{\"agent\":\"$agent_id\",\"environment_id\":\"$environment_id\"}")"
session_id="$(printf '%s' "$session" | field id)"

echo "5. live SSE and model round-trip"
sse_file="$(mktemp -t codex-sse.XXXXXX)"
cleanup() {
  if [ -n "${sse_pid:-}" ]; then kill "$sse_pid" 2>/dev/null || true; fi
  unlink "$sse_file" 2>/dev/null || true
}
trap cleanup EXIT
curl -fsSN -H "x-api-key: $RUNTIME_API_KEY" "$BASE/v1/sessions/$session_id/events/stream" >"$sse_file" &
sse_pid=$!
curl -fsS "${HDR[@]}" -X POST "$BASE/v1/sessions/$session_id/events" --data '{"events":[{"type":"user.message","content":[{"type":"text","text":"Follow your system instruction."}]}]}' >/dev/null

deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  events="$(curl -fsS "${HDR[@]}" "$BASE/v1/sessions/$session_id/events")"
  if printf '%s' "$events" | grep -q 'session.error'; then
    printf '%s\n' "$events" >&2
    exit 1
  fi
  if printf '%s' "$events" | grep -q 'session.status_idle'; then break; fi
  sleep 2
done
printf '%s' "$events" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).data||[];const text=e.filter(x=>x.type==='agent.message').flatMap(x=>x.content||[]).filter(x=>x.type==='text').map(x=>x.text||'').join('');if(!text.includes('CODEX BRIDGE OK')||!e.some(x=>x.type==='session.status_idle'))process.exit(1)})"
grep -q 'event: agent.message' "$sse_file"

echo "6. delete agent"
curl -fsS "${HDR[@]}" -X DELETE "$BASE/v1/agents/$agent_id" >/dev/null
echo "smoke: passed"
