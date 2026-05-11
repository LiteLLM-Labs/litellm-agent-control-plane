# @lap/managed-tools

Harness-agnostic tool specs and HTTP clients for capabilities the LAP
platform offers to every agent — currently agent memory.

## Why this exists

The platform exposes a small set of cross-cutting capabilities (memory,
and in time: secrets, telemetry, etc.) via HTTP endpoints on its own
backend. Every harness — `claude-agent-sdk`, `opencode`, future ones —
wants to expose these capabilities to the LLM as tools.

This package owns the parts that are the same regardless of which harness
calls them:

- **Input schemas** (zod) — what arguments the tool accepts
- **HTTP clients** — the actual `fetch` calls to the LAP API
- **Env-var contract** — `AGENT_ID`, `LAP_BASE_URL`, `LAP_AUTH_TOKEN`
- **Tool descriptions** — the natural-language doc the LLM reads to decide
  when to call

What stays harness-specific (and lives in each harness's own code) is the
glue that wraps these specs in that harness's tool-registration API. For
the Claude Agent SDK that's `createSdkMcpServer({ tools: [tool(...)] })`;
for opencode it'll be whatever opencode exposes.

## Layout

```
src/
  memory.ts   ← spec + client for save_memory / search_memory
  index.ts    ← re-exports
```

## Adding a new tool

1. Add a file under `src/` with the spec + client functions.
2. Export from `src/index.ts`.
3. Each harness adds an adapter that wraps the spec in its tool API.

## Consumption

This package sits at the repo root because it's a platform-level concern,
not a harness-specific one. Harnesses pick it up via a relative file dep:

```json
// harnesses/claude-agent-sdk/package.json
"dependencies": {
  "@lap/managed-tools": "file:../../managed-tools"
}
```

Each harness's Dockerfile builds with the **repo root** as its context so
both `managed-tools/` and the harness dir are visible at COPY time. The
container layout mirrors the source tree (`/opt/managed-tools` + matching
harness path) so the `file:../../managed-tools` path resolves at install
time without per-image rewriting.
