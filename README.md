# LiteLLM Agent Platform

We're introducing the **LiteLLM Managed Agents Platform** - a simple, self-hosted infrastructure platform for running multiple agents in production.

The main benefit of using this is that it will manage:
- Different sandboxes for different teams/contexts
- Session management across pod restarts/upgrades

We built this because we wanted a managed agent solution, but fully self-hosted. We are excited to have it open sourced and available for everyone to use.

<img width="1997" height="1219" alt="Xnapper-2026-05-08-19 10 50" src="https://github.com/user-attachments/assets/c0c2c2f8-d9e2-4821-b73a-e3971dac5169" />

---

## Quickstart

```bash
./setup.sh
docker compose up
```

Needs Docker Desktop, AWS credentials with ECS/ECR/EC2/IAM/Logs/STS, a LiteLLM gateway. First `./setup.sh` run creates `.env` (with a random `MASTER_KEY`) and exits — fill in your AWS keys and `LITELLM_API_BASE` / `LITELLM_API_KEY`, then re-run.

### Container env passthrough

Anything in `.env` prefixed `CONTAINER_ENV_` is injected into every Fargate container with the prefix stripped:

```bash
CONTAINER_ENV_GITHUB_TOKEN=ghp_...   # container sees GITHUB_TOKEN=ghp_...
```

### Cost + cleanup

A `ready` Fargate task runs ~$0.04/hr (0.5 vCPU + 1 GB). The reconciler kills idle sessions at 24h, capping a forgotten session at ~$1. Every `RECONCILE_INTERVAL_SECONDS`:

- Orphan tasks (no row, or row `dead/failed/stopped`) → `StopTask`. 5min grace.
- Sessions stuck `creating` > 10min → marked failed.
- Sessions in `ready` with `last_seen_at` > 24h → killed.

Manual stop: `DELETE /api/v1/managed_agents/sessions/{id}`.

### Custom harness

Drop a Dockerfile in `harnesses/<id>/`, re-run `./setup.sh`. Container must expose `POST /session` and `POST /session/{id}/message` on `CONTAINER_PORT`. Env injected at session start:

| Env | Source |
| --- | --- |
| `REPO_URL` | agent `repo_url`, else `PREINSTALLED_GITHUB_REPO` |
| `BRANCH` | agent `branch` (default `main`) |
| `LITELLM_API_BASE` `LITELLM_API_KEY` | host env |
| `LITELLM_DEFAULT_MODEL` | agent `model` |
| `AGENT_PROMPT` | agent `prompt` |
| `PORT` | `CONTAINER_PORT` |
| `<X>` | every host `CONTAINER_ENV_<X>` |

---

## For developers

Auth: `Authorization: Bearer <MASTER_KEY>` on every request.

Create an agent. Returns `{"id": "<agent_id>", ...}`.

```bash
curl -X POST http://localhost:3000/api/v1/managed_agents/agents \
  -H "Authorization: Bearer <MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "name":     "code-reviewer",
    "model":    "anthropic/claude-sonnet-4-6",
    "prompt":   "Review for clarity and security.",
    "repo_url": "https://github.com/BerriAI/litellm"
  }'
```

Spawn a session. Boots a Fargate task; ~60s cold. Returns `{"id": "<session_id>", "sandbox_url": "...", "status": "ready"}`.

```bash
curl -X POST http://localhost:3000/api/v1/managed_agents/agents/<agent_id>/session \
  -H "Authorization: Bearer <MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"title":"smoke"}'
```

Send a message. Body + response are the [opencode HTTP API](https://github.com/sst/opencode) verbatim.

```bash
curl -X POST http://localhost:3000/api/v1/managed_agents/sessions/<session_id>/message \
  -H "Authorization: Bearer <MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text":"What does this repo do?"}'
```

Stop the session. Tears down the Fargate task; otherwise the reconciler reaps it after 24h idle.

```bash
curl -X DELETE http://localhost:3000/api/v1/managed_agents/sessions/<session_id> \
  -H "Authorization: Bearer <MASTER_KEY>"
```

Reuse a session across messages — `POST /agents/{id}/session` is the slow path.

### Endpoints

```
GET    /api/v1/managed_agents/dockerfiles            list harnesses
GET    /api/v1/managed_agents/agents                 list
POST   /api/v1/managed_agents/agents                 create
GET    /api/v1/managed_agents/agents/{id}            fetch
PATCH  /api/v1/managed_agents/agents/{id}            update
POST   /api/v1/managed_agents/agents/{id}/session    spawn (slow)
GET    /api/v1/managed_agents/sessions               list, ?agent_id= optional
GET    /api/v1/managed_agents/sessions/{id}          fetch
DELETE /api/v1/managed_agents/sessions/{id}          stop
POST   /api/v1/managed_agents/sessions/{id}/message  chat

# passthroughs to LITELLM_API_BASE
GET    /api/v1/models
GET    /api/v1/mcp/server
GET    /api/mcp-rest/tools/list?server_id=...
```
