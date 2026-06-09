# SDK Agent Instructions

You are working inside `src/sdk/`. Read `docs/sdk_api.md` before making any changes.

## Core invariant

**The SDK must expose one surface for all runtimes. Callers use `agents.create → environments.create → sessions.create → events.send/stream` identically, regardless of which runtime is active. No `match runtime` or `if runtime == X` blocks in calling code, ever.**

All provider differences belong in `sdk/providers/<provider>/runtime/mod.rs`. If you find yourself writing runtime-specific logic anywhere else, stop and move it there instead.

## What is and is not allowed

| Allowed | Not allowed |
|---|---|
| `client.adapter(runtime)?.create_agent(...)` | `match runtime { Cursor => ..., Claude => ... }` in resources.rs |
| Override `provider_run_id_from_agent_raw` in CursorRuntime | Checking `if runtime == AgentRuntime::Cursor` in gateway code |
| Add a new provider under `sdk/providers/<name>/runtime/` | Adding `AgentRuntime::NewProvider` arm to gateway match blocks |
| Return `None` from a default trait method | Hardcoding provider URLs in gateway files |

## Output shapes follow the Anthropic API

`ManagedAgent`, `Session`, and `AgentEvent` follow the Anthropic Managed Agents API shape (see `docs/sdk_api.md`). If a runtime returns a different shape (e.g. Cursor), the adapter normalizes it. The caller always sees the Anthropic shape. The `.raw` field is the escape hatch for anything not yet covered by typed fields.

## Adding a new runtime

1. Create `sdk/providers/<name>/runtime/mod.rs`
2. Declare `pub(crate) const RUNTIME_ID: &str`, `RUNTIME_NAME`, `DEFAULT_API_BASE`
3. Implement `RuntimeAdapter` — all six required methods
4. Override optional methods (`normalize_stream`, `provider_run_id_from_agent_raw`, etc.) where the runtime differs from Anthropic behavior
5. In `sdk/providers/<name>/mod.rs`, call `registry.register(AgentRuntime::Name, RUNTIME_ID, RUNTIME_NAME, DEFAULT_API_BASE, NameRuntime)` from `register_runtime_adapters`
6. Add the `AgentRuntime::Name` variant to `AgentRuntime` in `sdk/agents/types.rs` and handle it in `LapConfig` + `runtime_configs()`
7. No other files require edits

## Conformance test

`tests/sdk_structure.rs::sdk_tree_matches_provider_endpoint_contract` enforces the file layout. Run `cargo test --test sdk_structure` after any structural change. It will fail if:

- `src/sdk/transformations/` exists
- `src/managed_agents/providers/` exists
- `src/sdk/providers/mod.rs` contains `match runtime` or `AgentRuntime::` dispatch

## Quick checklist before committing

- [ ] No `match runtime` blocks added outside `sdk/providers/<provider>/runtime/`
- [ ] `ManagedAgent` and `Session` typed fields populated from raw response in the adapter
- [ ] `cargo test` passes (including `sdk_structure` conformance test)
- [ ] New runtime? Registered in `mod.rs` — no other files modified
