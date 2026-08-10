# Reconcile a future upstream LACP release

This is the mandatory procedure for adopting a newer upstream LiteLLM Agent
Control Plane (LACP) release or commit when some downstream fixes may not yet
be present upstream. It is written for a coding agent. Follow it together with
[`codexgui-deployment.mdx`](./codexgui-deployment.mdx), which covers the actual
production deployment, backup, acceptance, and rollback procedure.

The goal is to take upstream bug fixes and improvements without losing any
behavior listed in this document. Do not merge an old downstream branch over a
new upstream tree wholesale. Start from the chosen upstream commit, determine
which behaviors it already implements, and port only what is still missing.

## Non-negotiable rules

- Work from an exact upstream commit SHA, never a floating tag or `latest`
  image.
- Use a fresh branch and worktree. Do not reconcile a release in the production
  checkout.
- Treat tests and observable behavior as authoritative. A matching commit
  title, file name, HTTP 200, healthy container, or completed parent session is
  not proof of equivalence.
- Preserve production database data, runtime state, environment files,
  encryption keys, browser profiles, and Caddy configuration.
- Never commit credentials, production environment contents, authentication
  state, private host keys, or a real delivery recipient.
- Keep provider-specific behavior behind its provider/runtime boundary. Follow
  [`CODING_STANDARDS.md`](../../CODING_STANDARDS.md).
- Do not declare a release ready while a required test is skipped. Record the
  skip as a blocker or run it in an environment that has the dependency.
- Do not send a real email or cause another external side effect during routine
  pre-production testing. Use a sink, dry-run mode, or a dedicated controlled
  acceptance recipient. Production side-effect acceptance must be intentional
  and exactly once.

## Required inputs and final evidence

Before editing, obtain and record:

1. The exact upstream repository URL, release/tag name, and full commit SHA.
2. The current downstream and production full commit SHAs and immutable image
   tags or digests.
3. The current status and head SHA of every pull request in the fix inventory
   below. Pull request heads can move; the SHAs in this document are the
   reviewed baseline as of 2026-08-10, not permanent aliases.
4. A disposable PostgreSQL connection for integration tests. Never point
   `TEST_DATABASE_URL` at production.
5. The test credentials and non-production endpoints needed for real Codex,
   MCP, browser, finance, PDF, and email-sink acceptance.

The completed release record must contain:

- upstream release name and full SHA
- reconciled downstream full SHA
- a disposition and evidence row for every fix in this document
- all test commands and pass/fail counts
- built image tags and digests
- sanitized end-to-end session IDs and provider delivery ID, when applicable
- known deviations, with an owner and explicit acceptance decision
- the production backup path, checksum verification, prior image tags, and
  rollback result after deployment

## Create an isolated reconciliation branch

Confirm remote ownership rather than assuming that `origin` means upstream:

```bash
git remote -v
git fetch origin --prune --tags
git fetch fork --prune
git status --short
git rev-parse HEAD
git rev-parse <upstream-release-ref>^{commit}
```

The status must be clean. Create a separate worktree from the exact upstream
SHA, then enable the committed hooks:

```bash
git worktree add \
  -b codex/reconcile-<upstream-version> \
  /root/git/litellm-agent-control-plane-reconcile-<upstream-version> \
  <full-upstream-sha>

cd /root/git/litellm-agent-control-plane-reconcile-<upstream-version>
git config core.hooksPath .githooks
git rev-parse HEAD
```

Do not begin with a merge of a previous integration branch. The new upstream
tree is the base.

## Fix inventory and behavioral contracts

Refresh each linked pull request before using this inventory. A fix can be
marked absorbed only after inspecting the new upstream implementation and
running the corresponding regression and acceptance tests.

### PR 493: large managed-runtime session replay

- Pull request: [#493](https://github.com/LiteLLM-Labs/litellm-agent-control-plane/pull/493)
- Reviewed head: `600cc239` (`Fix large runtime session replay`)
- Principal files:
  `src/db/managed_agents/runtime_events/repository.rs`,
  `src/http/sessions/runtime_events_api.rs`,
  `src/http/sessions/runtime_events_reconcile.rs`,
  `src/ui/src/app/chat/page.tsx`, `src/ui/src/components/sidebar.tsx`, and
  `src/ui/e2e/runtime-history-replay.spec.ts`

Behavior that must survive:

- Runtime-event history is loaded in a bounded bulk database operation rather
  than one decrypt/query operation per event.
- A completed history is stable: UI loading is deterministic, the provider is
  not fetched repeatedly, callbacks are not replayed, and each message is
  rendered once.
- A large response split across at least 1,100 fragments reconstructs exactly
  once after a full reload.
- Runtime aliases remain correct in the session list.
- Recent sessions and the completed response remain accessible on a narrow
  mobile viewport.

Required regression:

```bash
(
  cd src/ui
  npx playwright test e2e/runtime-history-replay.spec.ts
)
```

Both `replays a large completed runtime history exactly once` and `makes
recent sessions accessible in the mobile sidebar` must pass. Also inspect the
browser network log and confirm the history endpoint is requested once during
the tested load.

### PR 494: Codex API, ChatGPT, and remote SSH runtimes

- Pull request: [#494](https://github.com/LiteLLM-Labs/litellm-agent-control-plane/pull/494)
- Reviewed head: `ded09ead`
- Reviewed stack, oldest first: `816bb17b`, `20d4f1bd`, `c8fc56ad`,
  `0acec55e`, `2afc5177`, `c9755187`, `91d826c6`, `ce501946`, `ded09ead`
- Principal areas: `templates/codex/`, runtime-controller HTTP routes,
  runtime-profile UI and E2E tests, `deploy/codexgui.compose.yaml`,
  `deploy/litellm-agent-control-plane.service`, and
  `docs/engineering/codexgui-deployment.mdx`

Behavior that must survive:

- Codex is a first-class `claude_managed_agents` compatible runtime, with API,
  ChatGPT-account, and remote-SSH profiles selected through a controller.
- Runtime resolution goes through the configured controller/profile. It must
  not hardcode one Codex profile into provider-generic code.
- Profile APIs return masked metadata, never stored secrets. Sensitive profile
  values are encrypted at rest with authenticated encryption and use the
  stable production master key.
- ChatGPT mode uses the native account/model RPCs and persists its Codex
  authentication under the bind-mounted runtime state. Recreating a container
  must not silently sign the account out.
- Remote SSH validates the executable name, pins/verifies the host key, and
  does not convert an untrusted string into a shell command.
- Streamed Codex deltas have unique runtime event IDs while preserving their
  Codex item ID for correlation. Replay must not duplicate the final message.
- The runtime image runs as a non-root user and contains its required tools at
  build time. Agents must not install packages during a run.
- The Codex image baseline includes Bash, `curl`, `file`, `git`, `jq`,
  `procps`, `rg`, `unzip`, `zip`, Python 3, ReportLab, PyMuPDF, Poppler,
  Fontconfig, and DejaVu fonts.
- Production uses immutable image tags, persistent state mounts, supervised
  health, scoped registration jobs, root-only backups, and a data-preserving
  rollback. `docker compose down -v` is forbidden.

Minimum targeted checks:

```bash
npm ci --prefix templates/codex --no-audit --no-fund
npm test --prefix templates/codex

npm ci --prefix src/ui --no-audit --no-fund
(
  cd src/ui
  npx playwright test \
    e2e/codex-runtime-profiles.spec.ts \
    e2e/runtime-dropdown.spec.ts \
    e2e/runtime-session-reply.spec.ts
)
```

Build the Codex image as well. The build must validate its pinned Python
imports and must not rely on packages installed on the developer host.

### PR 495: stateful MCP tool discovery

- Pull request: [#495](https://github.com/LiteLLM-Labs/litellm-agent-control-plane/pull/495)
- Reviewed head: `82606b51` (`Fix stateful MCP tool discovery`)
- Principal files: `src/http/mcp_registry/discover.rs` and
  `src/http/mcp_registry/tools.rs`

Behavior that must survive:

- Discovery performs the complete Streamable HTTP MCP lifecycle:
  `initialize`, the `notifications/initialized` notification, `tools/list`,
  and session termination.
- The client carries the returned MCP session ID and negotiated protocol
  version on subsequent requests.
- Both JSON and SSE responses work.
- Configured authentication and static headers reach the MCP server without
  leaking into logs or error bodies.
- Discovery returns the actual tool list. An initialize-only HTTP 200 is not a
  passing result.

Required regression:

```bash
cargo test --locked discovers_tools_with_a_stateful_mcp_session
```

For every production MCP used by the workflow, also perform a real discovery
and one harmless tool call. Parse the JSON-RPC result and fail acceptance when
the response contains `isError: true`, even if the HTTP status is 200.

### PR 496: Codex MCP bridge and authoritative managed orchestration

- Pull request: [#496](https://github.com/LiteLLM-Labs/litellm-agent-control-plane/pull/496)
- Reviewed head: `6e9a8a75`
- Apply/port after PR 494 because it extends that Codex runtime.
- Reviewed stack after PR 494, oldest first: `f18aafbd`, `6d20ddba`,
  `a576e500`, `17b0f7ab`, `9f3caf61`, `53de509d`, `825bf94c`,
  `fb84e875`, `2e4cd9e6`, `9b1cc850`, `6e9a8a75`
- Principal files: `templates/codex/src/codex-app-server.mjs`,
  `templates/codex/scripts/verify-platform-routing.mjs`,
  `src/http/platform_mcps/`, `src/sdk/agents/events.rs`,
  `src/http/managed_agents/runs/create.rs`, and
  [`managed-agent-orchestration.mdx`](./managed-agent-orchestration.mdx)

Behavior that must survive:

- An agent's resolved MCP definitions are forwarded in Codex `thread/start`.
- The gateway credential is supplied by environment variable only to the
  trusted platform MCP definition after validating its expected origin and
  route. Platform traffic is rewritten to the private control-plane network;
  arbitrary external MCP definitions never receive the credential.
- MCP notifications are accepted without a JSON-RPC response; HTTP 202 is a
  valid notification result.
- Platform-managed Codex threads use LAP's `list_sub_agents` and
  `run_sub_agent` as the sole delegation mechanism. Native Codex collaboration
  is disabled only for those platform-managed threads, not for ordinary Codex
  use.
- Managed MCP threads set account apps off so a connected ChatGPT account
  cannot expose a second, ungoverned tool path.
- The LAP child timeout is 30 minutes and the Codex platform-MCP client timeout
  is 31 minutes. The local Codex command watchdog defaults to 600 seconds and
  must remain below the LAP deadline.
- SSE parsing buffers raw bytes across transport chunks. A multibyte UTF-8
  character split between chunks must decode without replacement or failure.
- A stalled Codex command is interrupted and produces a terminal error rather
  than leaving the child and parent indefinitely active.
- Manual `POST /api/agents/{agent_id}/run` launches the agent's configured
  managed runtime. It does not fall back to a legacy local harness merely
  because the run was started manually.
- `run_sub_agent` returns the child session ID, terminal status, and only the
  final assistant item selected by item ID. Streaming commentary fragments or
  earlier messages must not be presented as the final child result.
- A child stream ending unexpectedly, an error event, `failed`, or `timed_out`
  must not be converted into successful parent completion.
- The Codex image build runs the platform-routing verifier. The verifier proves
  that an ordinary thread retains native collaboration while a managed thread
  exposes only the governed platform path and has account apps disabled.

Minimum targeted checks:

```bash
cargo test --locked streaming_parser_buffers_split_utf8_code_points
cargo test --locked returns_structured_timeout_for_a_stalled_child
cargo test --locked preserves_child_text_and_terminal_failure
cargo test --locked rejects_a_stream_that_ends_without_a_terminal_event
cargo test --locked returns_only_the_final_agent_message_item

npm ci --prefix templates/codex --no-audit --no-fund
npm test --prefix templates/codex
```

The following Codex tests are especially important and must remain present or
be replaced by equivalent coverage:

- forwards the stored agent MCP servers when creating a Codex thread
- authenticates only the trusted platform MCP with the gateway credential
- routes a trusted platform MCP over the private control-plane network
- disables native Codex collaboration for LAP platform MCP threads
- refuses to expose the gateway credential to an untrusted platform MCP
- rejects invalid MCP definitions before starting a Codex thread
- interrupts a command that never emits `item/completed`
- clears the command watchdog after `item/completed`
- ChatGPT mode uses native account and model RPCs without an API provider

Do not run `verify-platform-routing.mjs` against an arbitrary host Codex
binary. Build `templates/codex/Dockerfile`; the build runs it against the
pinned runtime binary and fails if its assumptions no longer hold.

### PR 497: concurrent managed-runtime event sequencing

- Pull request: [#497](https://github.com/LiteLLM-Labs/litellm-agent-control-plane/pull/497)
- Reviewed head: `caca7217` (`Serialize managed runtime event sequences`)
- Principal files:
  `src/db/managed_agents/runtime_events/repository.rs` and
  `tests/managed_agents_api.rs`

Behavior that must survive:

- Allocating the next per-session event sequence is serialized inside the
  PostgreSQL transaction. Concurrent writers for one session cannot choose the
  same `MAX(seq) + 1` value.
- The lock is scoped to one session and one transaction; it must not globally
  serialize unrelated sessions.
- A burst of at least 32 concurrent appends succeeds, persists 32 distinct
  ordered events, and does not raise
  `LiteLLM_ManagedAgentRuntimeEventsTable_session_id_seq_key`.

Required regression against a disposable PostgreSQL database:

```bash
TEST_DATABASE_URL=<disposable-postgresql-url> \
  cargo test --locked --test managed_agents_api \
  runtime_event_appends_are_serialized_per_session -- --exact
```

SQLite, a mocked repository, or a sequential test is not an acceptable
substitute for this concurrency regression.

### Repository MCP attachment invariant

This invariant is also mandatory even if its implementation is reorganized:

- `mcp_server_ids` in `AgentDraft` is the sole source of truth.
- `createInputFromDraft` removes stale `mcp_toolset` entries from
  `draft.tools`, resolves the selected server IDs, and appends only fresh
  toolsets for known integrations.
- Backend `integration_mcp_toolsets` drops any toolset whose
  `mcp_server_name` is absent from the resolved `mcp_servers` list.

Run the focused frontend and backend tests for these functions, then create an
agent in the UI, add and remove an MCP, save it, reload it, and confirm that
the persisted MCP servers and toolsets exactly match the final selection. If
the future upstream tree does not contain direct unit coverage for this source
of truth, add it as part of reconciliation; UI acceptance alone is not enough.

## Classify each fix before porting code

Create a release ledger with one row for each PR and each repository invariant:

| Fix | Upstream evidence | Classification | Action | Regression | Result |
| --- | --- | --- | --- | --- | --- |
| #493 | files and tests | missing | port | replay E2E | pass |

Use these classifications:

- **Absorbed:** the reviewed change or a direct descendant is upstream and the
  regression passes.
- **Equivalent:** upstream uses a different implementation but every listed
  behavioral contract and regression passes. Cite the replacement files and
  tests.
- **Missing:** the behavior or its regression is absent. Port the smallest
  coherent change.
- **Obsolete:** upstream intentionally removed or replaced the feature. This
  requires written evidence, an updated acceptance contract, and explicit
  operator approval; lack of a merge is not evidence of obsolescence.

Useful comparisons:

```bash
git branch -r --contains <reviewed-head-sha>
git log --cherry-pick --right-only --no-merges \
  <upstream-sha>...<downstream-fix-branch>
git range-diff \
  <old-base>..<old-fix-head> \
  <upstream-sha>..<reconciliation-head>
git show <commit> | git patch-id --stable
```

Patch IDs help find exact or rebased patches, but they do not recognize a
different implementation with equivalent behavior. Conversely, a matching
test name does not prove the test still asserts the required failure mode.
Read both implementation and assertions.

## Porting order and conflict policy

Use this dependency order unless new upstream architecture requires a smaller
equivalent port:

1. Start from the exact new upstream commit.
2. Reconcile independent data/protocol fixes: PR 493, PR 495, and PR 497.
3. Reconcile the Codex runtime/controller and deployment base from PR 494.
4. Reconcile the Codex platform-MCP/orchestration extensions from PR 496.
5. Reconcile the MCP attachment invariant and any upstream changes that touch
   the same UI/backend boundary.
6. Run the full validation matrix before creating or updating a pull request.

When a cherry-pick conflicts:

- Keep the new upstream structure and reimplement the behavioral contract at
  the new owner. Do not preserve dead architecture merely to make a patch
  apply.
- Inspect schema and migration changes before adapting repository code. Never
  assume a table, unique index, or JSON column retained its old name.
- Keep HTTP handlers limited to protocol work and place provider-specific
  behavior in the provider/runtime implementation.
- Revalidate credential boundaries after any change to URL resolution,
  proxies, headers, or MCP configuration.
- Preserve stable encrypted state and profile compatibility or provide an
  explicit, tested migration and rollback path.
- Keep each port focused. Do not mix generated model-price changes with a
  behavioral fix unless the hook updates them during commit; review that diff
  separately.
- If a regression no longer fits the architecture, rewrite it before marking
  the behavior equivalent. Do not delete it without replacement.

## Full pre-merge validation matrix

Run from a clean reconciliation worktree. Use the toolchain pinned by the
repository or its containers. The Codex package requires Node 20 or newer;
native dependencies such as `better-sqlite3` can fail under the wrong ABI.

### Repository and diff hygiene

```bash
git status --short
git diff --check <upstream-sha>...HEAD
git diff --stat <upstream-sha>...HEAD
git log --oneline --decorate <upstream-sha>..HEAD
```

Review every changed environment, Compose, Caddy, profile, authentication, and
deployment file for embedded secrets and environment-specific values. Confirm
that only placeholders and variable names are committed. The final status must
be clean and the reviewed full SHA must equal the built SHA.

### Rust gateway

```bash
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --release --locked
```

Then run the PR 495, PR 496, and PR 497 focused tests listed above. PR 497 must
use disposable PostgreSQL 16 or the production major version, not an implicit
skip. If the host lacks Rust, use a pinned Rust builder container and preserve
the exact command and image digest in the release record.

### UI

```bash
npm ci --prefix src/ui --no-audit --no-fund
npm run lint --prefix src/ui
npm run build --prefix src/ui
(
  cd src/ui
  npx playwright test
)
```

At minimum, retain explicit coverage for large history replay, mobile session
access, runtime profile creation, connected-runtime selection, disconnected
runtime fallback, and managed-runtime replies. Playwright requires a started
test UI. Use its default `http://localhost:3210` or set
`PLAYWRIGHT_BASE_URL` to the isolated test deployment; never aim E2E tests that
mutate state at production.

### Runtime packages and images

Run every runtime package's committed tests, including at least:

```bash
npm ci --prefix templates/codex --no-audit --no-fund
npm test --prefix templates/codex
npm ci --prefix templates/opencode --no-audit --no-fund
npm test --prefix templates/opencode
```

Build every changed image using the commands and immutable tags in
[`codexgui-deployment.mdx`](./codexgui-deployment.mdx). Build Codex without
bypassing its routing verifier. After starting the test stack, check the
runtime contents rather than assuming Dockerfile steps succeeded:

```bash
docker exec <codex-container> sh -lc \
  'command -v curl git jq rg file pdfinfo pdftotext pdftoppm python3 unzip zip'
docker exec <codex-container> python3 -c 'import pymupdf, reportlab'
```

Verify that containers run as the intended non-root user, persistent mounts
resolve to the intended test paths, health checks pass, and registration jobs
exit successfully. Render the Compose configuration with test placeholder
values and inspect it before starting anything.

## Protocol and end-to-end acceptance

Unit tests are necessary but do not cover the production boundaries that
failed previously. Perform these checks before deployment against a test stack
and repeat the production-safe subset after deployment.

### Stateful MCP and remote browser

For each stateful MCP, especially the remote browser:

1. Execute `initialize` and record the negotiated protocol version and session
   header without recording credentials.
2. Send `notifications/initialized` using the same session.
3. Call `tools/list` and assert that the expected browser tools are present.
4. Call a harmless tool such as a page snapshot against a deterministic test
   page.
5. Inspect the JSON-RPC tool result and require `isError` to be absent or
   false. HTTP 200 alone is insufficient.
6. Terminate the MCP session and confirm the server releases it.
7. Repeat through the public proxied route and, where available, directly
   through the origin/private route. A difference isolates proxy/CDN behavior
   from the MCP container and browser lifecycle.

Also verify the external remote-browser service's own functional health check.
A TCP check, MCP initialize response, container health, or browser process
alone does not prove that a browser tool can create/use a page successfully.

### Parent/child orchestration

Create or use a non-production parent with at least two children and the same
runtime/MCP topology as the real workflow:

1. Start the parent manually through `POST /api/agents/{agent_id}/run` and
   capture its session ID.
2. Confirm it discovers children through `list_sub_agents` and invokes only
   governed `run_sub_agent` tools.
3. Run two children concurrently to exercise per-session event allocation.
4. Include a browser child, a data/finance child, and an artifact/PDF child if
   those exist in the production workflow.
5. Include non-ASCII text whose UTF-8 bytes can cross SSE chunks.
6. Confirm every child has a distinct session, reaches a real terminal status,
   has no unresolved tool call, and returns the final assistant item rather
   than commentary.
7. Confirm the parent receives each terminal result, rejects `failed` and
   `timed_out` children, and reaches its own terminal event only after required
   children succeed.
8. Query durable runtime events by the event JSON `type` as well as any
   denormalized column; do not assume the denormalized value is populated for
   every historical producer.
9. Confirm no duplicate `(session_id, seq)` values and no duplicate final
   message are present.

There is no guaranteed durable parent-child foreign key in older deployments.
Correlate using the `run_sub_agent` tool event, child session ID returned by
the tool, agent ID, and timestamps. Parent completion alone is not success.

### Artifact and delivery acceptance

For a report workflow:

1. Verify every required source/reconciliation section independently. Do not
   silently substitute amount similarity for missing merchant evidence.
2. Open the generated PDF, render its pages, and inspect content and page
   count. File existence and a successful PDF library call are insufficient.
3. Validate the parent consumed the final artifact, not a stale path or an
   earlier draft.
4. In pre-production, deliver to a sink and assert one message, the intended
   subject/body, and the exact attachment checksum.
5. For controlled production acceptance, use one explicit recipient and an
   idempotency key. Before retrying an ambiguous send, search the provider for
   the existing message. Record the provider message ID and prove that a second
   invocation with the same key does not send a duplicate.

The user-facing result must say whether all source reconciliations succeeded,
whether delivery was attempted, and whether the provider confirmed it. A
generated PDF is not proof of delivery, and a parent marked completed is not
proof that either happened.

## Production release and rollback gates

Only after the reconciliation ledger and all applicable tests pass:

1. Commit the reviewed tree and push the reconciliation branch.
2. Open a pull request whose body includes the ledger, test evidence, upstream
   and downstream full SHAs, schema/migration impact, deployment order, and
   rollback plan.
3. Require review of security-sensitive credential, MCP, SSH, Compose, and
   persistence changes.
4. Build immutable images from the reviewed commit and record their digests.
5. Follow every backup, activation, real-browser acceptance, and rollback step
   in [`codexgui-deployment.mdx`](./codexgui-deployment.mdx).

Stop and roll back when any of these occurs:

- a required migration fails or old data cannot be read
- a runtime profile or persistent ChatGPT authentication disappears
- any required container restarts repeatedly or a registration job fails
- stateful MCP discovery or a real browser tool call fails
- a child fails while the parent reports success
- runtime event sequence uniqueness is violated
- the final report is incomplete, duplicated, or not renderable
- delivery is missing, ambiguous, or duplicated

Do not delete prior images or the release backup until the rollback window has
elapsed and a complete production workflow has passed.

## Definition of done

A future upstream release is reconciled only when all of the following are
true:

- Every fix and invariant in this document has an evidence-backed disposition.
- Missing behavior was ported as focused commits onto the new upstream base.
- Full Rust, UI, runtime, image-build, PostgreSQL-concurrency, MCP protocol,
  browser, parent/child, artifact, and controlled delivery checks applicable to
  the release passed.
- No required check was silently skipped and no real secret entered the diff or
  logs.
- The reconciled commit and image digests are immutable and recorded.
- Production backup and rollback artifacts were verified before activation.
- Production acceptance inspected every required child and actual tool result,
  not only the parent status and health endpoints.
- The worktree is clean, the pushed SHA matches the reviewed SHA, and the
  release record contains enough sanitized evidence for another operator to
  reproduce the decision.
