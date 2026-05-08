# LiteLLM Agent Platform

A control plane for **managed agents** running on a [LiteLLM](https://github.com/BerriAI/litellm) AI Gateway. Create agents, spawn sandboxed sessions, watch them stream events back.

Each agent is `(harness, repo)` — e.g. opencode + your monorepo. Spawning a session boots a fresh Fargate task running that harness against that repo. The proxy owns the lifecycle. This UI talks to it.

Pairs with [BerriAI/litellm#27427](https://github.com/BerriAI/litellm/pull/27427). Requires `general_settings.managed_agents.enabled: true` on the proxy.

## What you get

![Agents list](./docs/screenshots/agents.png)

![Agent detail](./docs/screenshots/agent-detail.png)

## How it works

```
   browser                this UI                  LiteLLM proxy            Fargate
   ───────                ───────                  ─────────────            ───────

   click "spawn"   ───►   POST /api/proxy/...
                          + Authorization header   POST /v1/managed_agents
                          (server-side)            /agents/{id}/session     boots task
                                                                            (~50–90s)
   stream events   ◄───   GET  /api/proxy/...      GET .../sessions/{id}    SSE
                          (passes SSE through)     /events
```

The browser never holds the proxy API key. It hits `/api/proxy/[...path]` on this app — a Next.js Route Handler that attaches `Authorization: Bearer $LITELLM_API_KEY` server-side and forwards to `$LITELLM_BASE_URL`. Inspecting the page bundle or the Network tab will not leak the key.

## Deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2FBerriAI%2Flitellm-agent-platform)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/BerriAI/litellm-agent-platform)

Set two **server-side** env vars. They must NOT have a `NEXT_PUBLIC_` prefix.

| Var                | Example                            |
| ------------------ | ---------------------------------- |
| `LITELLM_BASE_URL` | `https://your-proxy.example.com`   |
| `LITELLM_API_KEY`  | `sk-...` (master or virtual key)   |

### Docker

A `Dockerfile` is included for one-click deploys to anything that runs
containers (Fly, Cloud Run, ECS, Kubernetes, your laptop):

```bash
docker build -t litellm-agent-platform .
docker run --rm -p 3000:3000 \
  -e LITELLM_BASE_URL=https://your-proxy.example.com \
  -e LITELLM_API_KEY=sk-... \
  litellm-agent-platform
```

The image uses Next.js standalone output — the final stage is ~150 MB and
runs as a non-root user.

## Run locally

```bash
npm install
cp .env.local.example .env.local   # fill in LITELLM_BASE_URL + LITELLM_API_KEY
npm run dev                         # http://localhost:3000
```

## Proxy endpoints used

```
GET    /v1/managed_agents/dockerfiles
GET    /v1/managed_agents/sandbox-templates
POST   /v1/managed_agents/agents
GET    /v1/managed_agents/agents
GET    /v1/managed_agents/agents/{id}
PATCH  /v1/managed_agents/agents/{id}                # name + pfp_url + mcp_servers
POST   /v1/managed_agents/agents/{id}/session        # boots Fargate, ~50–90s
GET    /v1/managed_agents/sessions
GET    /v1/managed_agents/sessions/{id}
POST   /v1/managed_agents/sessions/{id}/message
GET    /v1/managed_agents/sessions/{id}/events       # SSE
DELETE /v1/managed_agents/sessions/{id}
GET    /v1/mcp/server                                # MCP picker
GET    /v1/models                                    # model picker
```

## Stack

- Next.js 16 App Router · React 19
- Tailwind v4 · shadcn/ui
- Server-side proxy route — API key never leaves the server
