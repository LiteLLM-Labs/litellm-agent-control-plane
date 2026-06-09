# Agent Runtime SDK

`src/sdk` is the public Rust client surface for request routing and provider
endpoint transformation across model APIs and managed-agent runtimes.

It exposes:

- `Lap` and `LapConfig` for configuring runtime credentials.
- `client.beta().agents()`, `environments()`, and `sessions()` resource handles.
- Normalized session event streaming across supported runtimes.
- Typed event views via `AgentEvent::kind()` and `AgentEvent::payload()`.

Runtime-specific request shapes live behind provider-owned adapters in
`src/sdk/providers/<provider>/runtime/`. Adding another runtime should add an
adapter there and register it from the provider module instead of
adding new `match AgentRuntime` branches throughout the SDK resource layer.

Base transformation traits live under `src/sdk/providers/base/`, including
endpoint-family bases for `anthropic_messages` and `openai_responses`. Model
routing lives in `src/sdk/routing.rs`; provider-owned endpoint translations and
runtimes live under `src/sdk/providers/<provider>/`.
