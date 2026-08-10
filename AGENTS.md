# AGENTS.md

Before making implementation changes, read and follow the repo-wide
[`CODING_STANDARDS.md`](./CODING_STANDARDS.md).

## First-time setup

Run once after cloning to activate the committed git hooks:

```bash
git config core.hooksPath .githooks
```

The pre-commit hook keeps `model_prices_backup.json` in sync with the
upstream litellm JSON on every commit. It warns and skips silently if
the network is unavailable — it never blocks a commit.

## codexgui production deployment

For the deployed topology, initial server setup, PostgreSQL integration,
future-release procedure, acceptance tests, and rollback steps, follow
[`docs/engineering/codexgui-deployment.mdx`](./docs/engineering/codexgui-deployment.mdx).

Treat the environment files and persistent-state paths named in that runbook as
production data. Never commit their contents or replace stable encryption keys
during a routine release.

## Future upstream releases

Before adopting a newer upstream release or commit, follow
[`docs/engineering/upstream-release-reconciliation.md`](./docs/engineering/upstream-release-reconciliation.md).
It inventories the downstream fixes and behavioral invariants that must be
preserved, defines how to classify upstream equivalents, and lists the required
code, database, runtime, MCP, browser, orchestration, artifact, delivery,
deployment, and rollback validation.

## MCP integration invariants

`mcp_server_ids` (in `AgentDraft`) is the **sole source of truth** for which
MCP integrations are attached to an agent.

- `createInputFromDraft` must derive `mcp_servers` and `mcp_toolset` tool
  entries exclusively from `mcp_server_ids`. Never read `mcp_toolset` entries
  back out of `draft.tools` to build the output — those may be stale.
- Strip all `mcp_toolset` entries from `draft.tools` before building
  `allTools`, then append fresh toolsets from `resolvedMcpServers`.
- Only emit a toolset for an ID that resolved to a known `INTEGRATIONS` entry.
  An ID with no matching integration produces no toolset and no server URL.

On the backend (`runtime_provision.rs`), `integration_mcp_toolsets` must
cross-check each toolset's `mcp_server_name` against the resolved `mcp_servers`
list. Any toolset whose server name is absent from `mcp_servers` is dropped.
