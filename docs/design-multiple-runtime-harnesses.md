# Design: Multiple Runtime Harnesses with Aliases (v3)

## Problem

Gateway has hardcoded runtimes (`claude_managed_agents`, `cursor`, `gemini_antigravity`, `opencode`). Users need additional harness endpoints (e.g. staging Anthropic, team-specific Cursor) addressable by alias. Alias must survive the full session lifecycle and drive the same spec-specific UI behavior as the built-in runtime it wraps.

## Goals

- Admin registers custom harnesses with aliases; users reference by alias
- Zero breaking changes — existing runtime names work unchanged
- Alias → api_spec resolution used for all spec-specific behavior (model routing, repo env, route prefix)

## Non-Goals

- Per-user harness scoping (global/admin-only for now)

---

## Backend: `ResolvedRuntime`

Single async resolver used by every session code path:

```rust
pub(crate) struct ResolvedRuntime {
    pub alias: String,           // stored as session.runtime in DB
    pub agent_runtime: AgentRuntime,  // from api_spec or direct static match
    pub credential: RuntimeCredential,
    pub adapter: Arc<dyn RuntimeAdapter>,
}

pub(crate) async fn resolve_runtime(pool, state, alias) -> Result<ResolvedRuntime, _> {
    // 1. Static registry (unchanged path for defaults)
    // 2. DB lookup by alias → api_spec maps to existing adapter + harness credential
}
```

`CreatedRuntimeSession` carries `resolved: ResolvedRuntime`. All downstream code (provision, sdk_client, register_session, follow-up prompts, event streaming) uses `resolved.agent_runtime` / `resolved.adapter` without re-fetching.

---

## Data Model

```sql
CREATE TABLE IF NOT EXISTS "LiteLLM_RuntimeHarnessTable" (
  id          TEXT PRIMARY KEY,
  alias       TEXT UNIQUE NOT NULL,
  api_spec    TEXT NOT NULL CHECK (api_spec IN ('claude_managed_agents', 'cursor', 'gemini_antigravity', 'opencode')),
  api_base    TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
```

API key: `LiteLLM_CredentialsTable`, `credential_name = 'runtime-harness:{alias}'`, `scope = 'global'`, encrypted via `credential_crypto`.

---

## API

Keep `/api/agent-runtimes` intact. Add:

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/runtime-harnesses` | see response shape below |
| POST | `/api/runtime-harnesses` | `{ alias, api_spec, api_base, api_key }` |
| PUT | `/api/runtime-harnesses/{alias}` | update credentials |
| DELETE | `/api/runtime-harnesses/{alias}` | custom only |

All write operations: master key required, atomic (harness row + credential in sync), reserved/non-slug alias rejected.

Reserved aliases: `claude_managed_agents`, `cursor`, `gemini_antigravity`, `opencode`, `claude_agents`.
Valid slug: `[a-zA-Z0-9_-]+`.

### GET /api/runtime-harnesses — exact response shape

```json
{
  "harnesses": [
    {
      "alias": "claude_managed_agents",
      "api_spec": "claude_managed_agents",
      "display_name": "Claude Agents",
      "api_base": "https://api.anthropic.com",
      "is_default": true,
      "connected": true,
      "masked_api_key": "sk-ant-...xxxx",
      "tools": [{ "id": "...", "name": "...", "description": "...", "enabled_by_default": true }]
    },
    {
      "alias": "cursor",
      "api_spec": "cursor",
      "display_name": "Cursor",
      "api_base": "https://api.cursor.com",
      "is_default": true,
      "connected": false,
      "masked_api_key": null,
      "tools": []
    },
    {
      "alias": "opencode",
      "api_spec": "opencode",
      "display_name": "OpenCode",
      "api_base": "http://127.0.0.1:4096",
      "is_default": true,
      "connected": false,
      "masked_api_key": null,
      "tools": []
    },
    {
      "alias": "anthropic-dev",
      "api_spec": "claude_managed_agents",
      "display_name": "anthropic-dev",
      "api_base": "https://api.anthropic.com",
      "is_default": false,
      "connected": true,
      "masked_api_key": "sk-ant-...yyyy",
      "tools": [{ "id": "...", "name": "...", "description": "...", "enabled_by_default": true }]
    }
  ]
}
```

Fields: `alias` (stored in session.runtime), `api_spec` (BuiltinRuntimeId, drives spec-specific behavior), `display_name`, `api_base`, `is_default`, `connected`, `masked_api_key`, `tools` (inherited from api_spec entry).

---

## Frontend: `resolveApiSpec` pattern

All spec-specific UI branches switch from alias string comparison to `api_spec` comparison. One shared helper:

```typescript
function resolveApiSpec(alias: string, harnesses: RuntimeHarness[]): BuiltinRuntimeId {
  if (alias === "claude_managed_agents" || alias === "cursor" || alias === "gemini_antigravity" || alias === "opencode") {
    return alias as BuiltinRuntimeId;
  }
  return harnesses.find(h => h.alias === alias)?.api_spec ?? "claude_managed_agents";
}
```

Both `sessions/page.tsx` and `chat/page.tsx` load harnesses from `listRuntimeHarnesses()` into state and use `resolveApiSpec` when branching on spec (model routing, cursor env/repo gating, route prefix).

**`AgentRuntimeId`** widened to `string`. **`BuiltinRuntimeId`** is the 3-value union used for spec branching.

Spec-specific functions (`modelForRuntime`, `runtimeModelId`, `runtimeRoutePrefix`, cursor env gating) all updated to accept `BuiltinRuntimeId` from `resolveApiSpec`, not the raw alias string.

---

## Tests

Backend integration: create harness, session via alias, follow-up prompt, list/stream events, delete (row + credential), reject reserved + non-slug aliases.
