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

## Fork & deployment (lap.it-expert.com.ua)

This section lives only on the fork's `deploy/consolidated` branch — keep it
out of upstream PRs.

- Remotes: `origin` = upstream `LiteLLM-Labs/litellm-agent-control-plane`,
  `fork` = `mprokopov/litellm-agent-control-plane`.
- `fork/deploy/consolidated` is what runs in production: upstream `main` merged
  with fixes not yet accepted upstream. Each fix should also have its own
  branch and an open upstream PR.
- Nomad jobs live in `~/it-premium/nomad` (`lap.nomad.hcl`,
  `lap-opencode.nomad.hcl`). Both pin `var.version` to the same tag.

### Is the fork still needed?

```bash
git fetch --all
git cherry -v origin/main fork/deploy/consolidated   # "+" = not upstream yet
gh pr list -R LiteLLM-Labs/litellm-agent-control-plane --author @me --state all
```

The fork can be retired once the only `+` commits left are docs (like this
section). Then build from `origin/main` instead.

### Updating to the latest version

1. Merge `origin/main` into `deploy/consolidated` and push to `fork`.
2. Build both images for `linux/amd64` — the Nomad clients are x86_64, and an
   arm64 image fails at runtime with `exec format error`. Tag with
   `<short-sha>-amd64`:

   ```bash
   V=$(git rev-parse --short=8 HEAD)-amd64
   docker buildx build --platform linux/amd64 -t registry.it-expert.com.ua/lap:$V --push .
   docker buildx build --platform linux/amd64 -t registry.it-expert.com.ua/lap-opencode:$V --push templates/opencode
   curl -s https://registry.it-expert.com.ua/v2/lap/tags/list
   ```

3. In `~/it-premium/nomad`, set `var.version` to `$V` in both job files, then
   `nomad job plan` / `nomad job run` (see that repo's `bump-version` skill).
