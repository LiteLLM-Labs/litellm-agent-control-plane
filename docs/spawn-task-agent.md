# Spawning a task-specific agent

Use this when a task is better handled by a dedicated agent than by doing it inline. Examples: "spin up a PR review agent for this repo", "create a security scanning agent", "delegate this refactor to a fresh agent".

## When to spawn vs. do inline

Spawn a new agent when:
- Task requires a different system prompt or skill set than your own
- Task is long-running and you need to continue other work
- Task is repeatable and the agent should persist for future use

Do inline when the task is a single one-off that fits in your current session.

## API: create agent

```bash
POST $LAP_BASE_URL/api/v1/managed_agents/agents
Authorization: Bearer $LAP_MASTER_KEY
Content-Type: application/json

{
  "name": "<descriptive name>",
  "model": "anthropic/claude-sonnet-4-6",
  "prompt": "<system prompt for this agent's specific task>",
  "harness_id": "claude-agent-sdk",
  "requirements": "<optional pip packages, e.g. semgrep==1.72.0>"
}
```

Response contains `id` — that is the `agent_id`.

## API: create session and send a message

```bash
# 1. Create session
POST $LAP_BASE_URL/api/v1/managed_agents/agents/{agent_id}/session
Authorization: Bearer $LAP_MASTER_KEY
Content-Type: application/json
{}

# 2. Wait for status=ready (poll every 3s, timeout 120s)
GET $LAP_BASE_URL/api/v1/managed_agents/sessions/{session_id}
Authorization: Bearer $LAP_MASTER_KEY

# 3. Send message — response is SYNCHRONOUS, returned in the body
POST $LAP_BASE_URL/api/v1/managed_agents/sessions/{session_id}/message
Authorization: Bearer $LAP_MASTER_KEY
Content-Type: application/json

{ "text": "<your task description>" }
```

Response body: `{ "parts": [{ "type": "text", "text": "<agent response>" }] }`

## API: stop session when done

```bash
POST $LAP_BASE_URL/api/v1/managed_agents/sessions/{session_id}/stop
Authorization: Bearer $LAP_MASTER_KEY
```

## Attaching a skill

To give the new agent a pre-built skill from the library:

```bash
POST $LAP_BASE_URL/api/v1/managed_agents/agents/{agent_id}/skill
Authorization: Bearer $LAP_MASTER_KEY
Content-Type: application/json

{ "skill_id": "<skill_id>" }
```

Or inline (saves a new skill automatically):

```bash
{ "name": "<skill name>", "content": "<skill content>" }
```

## Environment variables available inside the agent

Pass secrets the agent needs via session-level `env_vars`:

```bash
POST $LAP_BASE_URL/api/v1/managed_agents/agents/{agent_id}/session
{
  "title": "optional title",
  "env_vars": {
    "GITHUB_TOKEN": "<token>",
    "CUSTOM_VAR": "value"
  }
}
```

## Full shell example

```bash
BASE="$LAP_BASE_URL"
KEY="$LAP_MASTER_KEY"

# Create agent
AGENT_ID=$(curl -s "$BASE/api/v1/managed_agents/agents" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"pr-review","model":"anthropic/claude-sonnet-4-6","prompt":"You are a senior engineer reviewing PRs.","harness_id":"claude-agent-sdk"}' \
  | jq -r '.id')

# Create session
SID=$(curl -s "$BASE/api/v1/managed_agents/agents/$AGENT_ID/session" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{}' | jq -r '.id')

# Poll until ready
until [ "$(curl -s "$BASE/api/v1/managed_agents/sessions/$SID" -H "Authorization: Bearer $KEY" | jq -r '.status')" = "ready" ]; do sleep 3; done

# Send task
RESPONSE=$(curl -s -X POST "$BASE/api/v1/managed_agents/sessions/$SID/message" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"text":"Review PR: https://github.com/org/repo/pull/1"}' \
  | jq -r '.parts[].text')

echo "$RESPONSE"

# Stop session
curl -s -X POST "$BASE/api/v1/managed_agents/sessions/$SID/stop" -H "Authorization: Bearer $KEY"
```
