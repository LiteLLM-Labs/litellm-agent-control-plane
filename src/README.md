# src/

Source layout for the litellm-rust gateway. A request flows
`endpoint → router → transformation → llm api`; see
[docs/architecture.md](../docs/architecture.md) for the full picture.

The codebase splits request routing, provider endpoint transformation,
managed-agent runtime SDK, and proxy concerns. SDK routing lives in
`sdk/routing.rs`, provider-specific implementations live under
`sdk/providers/`, and the proxy server wraps them with config, auth, state,
and HTTP routes.

## Entrypoints

| File | What it does |
|---|---|
| `main.rs` | Binary entry. Parses args, loads config, builds the provider registry + router, starts the server. Also dispatches the `claude` CLI wizard. |
| `lib.rs` | Crate root. Declares the public modules below. |
| `errors.rs` | `GatewayError` — the shared error type, mapped to HTTP responses in one place. Used by both halves, so it lives at the top level. |

## Folders

| Folder | Responsibility |
|---|---|
| `sdk/routing.rs` | **Routing.** Request/model routing above provider endpoint transformation. |
| `sdk/providers/base/` | **Base transformations.** Endpoint-family base traits and the runtime adapter base trait. |
| `sdk/providers/<provider>/<endpoint>/` | **Provider integrations.** Each provider owns its supported capabilities: `<endpoint>/` for request transformation, `runtime/` for managed-agent adapters. |
| `sdk/agents/` | **Agent Runtime SDK.** The `Lap` client, public runtime resource types, and normalized events. |
| `proxy/` | **Proxy-server concerns**, kept out of the SDK: `config.rs` (`config.yaml` parse + env expansion + validation), `state.rs` (`AppState` — config, router, shared HTTP client), `auth/` (master-key check). |
| `http/` | HTTP layer. Routes (`routes.rs`), the `/v1/messages` endpoint (`messages.rs`), health check, and `llm.rs` — the **only** place that does outbound networking to providers. |
| `cli/` | The `litellm-rust claude` wizard: configures Claude Code to point at the gateway (arg parsing, credential storage, terminal prompts). |

## Adding a provider

Drop a provider folder under `sdk/providers/<name>/` with a `<endpoint>/mod.rs`
(`pub fn init`) and a `<endpoint>/transformation.rs`. `build.rs` wires it in
automatically. See [docs/architecture.md](../docs/architecture.md#providers-are-self-contained).
