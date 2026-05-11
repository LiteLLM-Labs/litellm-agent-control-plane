# Claude Agent SDK harness

A peer of [`harnesses/opencode/`](../opencode/), built on Anthropic's [`@anthropic-ai/claude-agent-sdk`](https://docs.anthropic.com/en/api/agent-sdk/typescript). Same HTTP surface — the platform's `src/server/harness.ts` doesn't know the difference between this and opencode at the wire level.

## Why this exists

opencode has known lifecycle bugs in its bash-tool wrapper and stream parser (sessions can wedge with `state.status: "running"` indefinitely after a child process exits). The Claude Agent SDK is Anthropic's first-party agent loop — tool execution, streaming, and session persistence are first-class and maintained.

Pick at session-create time via `Agent.harness_id`:
- `harness_id = "opencode"` → routes to `harnesses/opencode/` task definition (multi-provider via LiteLLM)
- `harness_id = "claude-agent-sdk"` → routes here (Anthropic-first, fewer harness bugs)

The platform's per-harness task-definition lookup is a separate change in `src/server/fargate.ts`; this directory just ships the harness binary itself.

## HTTP API (drop-in compatible with opencode)

```
POST /session                             { title? }                   → { id, title }
POST /session/{id}/message                { model, parts }             → HarnessMessageResponse (blocking)
POST /session/{id}/prompt_async           { model, parts }             → 204 (fire-and-forget for streaming)
GET  /session/{id}/message                                              → PlatformMessage[]
POST /session/{id}/abort                                                → { ok: true }
GET  /event                                                             → SSE bus (server.connected, message.part.updated, session.idle, …)
GET  /                                                                  → harness identity
```

Bus events match opencode's filter contract — `properties.sessionID` carries the harness session id so the platform's `message_stream` route can fan out to the right browser.

## Container env

The platform's `fargate.ts:buildContainerEnv` already provides everything we need; the only translation is renaming the LiteLLM gateway pair to the SDK's expected names (handled at boot in `server.ts`):

```
LITELLM_API_BASE        → ANTHROPIC_BASE_URL
LITELLM_API_KEY         → ANTHROPIC_AUTH_TOKEN + ANTHROPIC_API_KEY
LITELLM_DEFAULT_MODEL   → DEFAULT_MODEL
AGENT_PROMPT            → SDK options.customSystemPrompt
REPO_URL / BRANCH       → cloned to /work/repo by entrypoint.sh
GITHUB_TOKEN / GH_TOKEN → preserved for `gh pr create` / `git push`
GIT_TOKEN               → clone-only; wiped after clone
PORT                    → server bind port (default 4096)
```

## Pre-installed tooling

The image ships with `gh`, `curl`, `git`, `python3`, `jq`, `uv`, `uvx`. These were the gaps that bit sessions on the opencode harness today (e.g. agent had to bootstrap `uv` via `python3 urllib.request` because `curl` wasn't installed). All pinned + checksummed.

## Build & push

The build context is the repo root because this image bundles the
platform-level [`@lap/managed-tools`](../../managed-tools/) package:

```bash
docker buildx build --platform linux/amd64 \
  -f harnesses/claude-agent-sdk/Dockerfile \
  -t litellm-agents-claude-sdk:$(git rev-parse --short HEAD) \
  .
# tag + push to ECR using the same flow setup.sh uses for opencode,
# then register a separate task definition family.
```

A follow-up PR will extend `setup.sh` to build/push both harness images and register both task definitions, so picking the harness at agent-create time is just a column in the DB.

## Why session continuity works without us tracking history

The SDK persists sessions to disk under the configured `cwd`. We capture `session_id` from the SDK's `system.init` event on the first turn and pass it back as `options.resume` on every subsequent turn — the SDK stitches the new turn onto the prior conversation, including tool use / tool results, with no manual history bookkeeping on our side. That's the main reason this harness is small (~330 LOC) compared to opencode.
