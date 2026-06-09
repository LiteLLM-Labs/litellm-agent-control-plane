# Writing Managed-Agent Provider Integrations

Use this checklist when adding a new managed-agent runtime provider.

## Files

- Add SDK protocol mapping under `src/sdk/agents/`.
- Add or update the gateway provider adapter under `src/managed_agents/providers/`.
- Add runtime credentials and runtime ids under `src/managed_agents/providers/base.rs` and `src/http/agent_runtimes.rs`.
- Add contract tests in `tests/managed_agents_sdk.rs`.
- Add gateway tests in `tests/managed_agents_support/flows.rs` when HTTP routes are involved.

## SDK Contract

- Keep the public surface Anthropic-shaped:
  `beta().agents().create`, `beta().environments().create`,
  `beta().sessions().create`, `beta().sessions().events().send`, and
  `beta().sessions().events().stream`.
- Prefix LAP-only fields with `lap_`.
- Use `lap_provider_options` only for gateway-owned provider-specific fields
  that cannot be represented by the Anthropic-shaped contract.
- Do not add database, vault, or idempotency logic to the SDK.
- Use `ManagedSessionRef` when gateway code needs to register DB-loaded local
  session ids with provider ids.

## Provider Mapping

- Translate request bodies in provider-specific helpers.
- Keep provider auth isolated to SDK request construction.
- Normalize provider streams before exposing public SDK events.
- Do not leak provider-specific event names from `events().stream`.
- Store provider session/run ids in gateway DB rows, not in SDK state alone.

## Tests

- Mock provider create/send/stream endpoints.
- Assert exact translated request bodies and auth headers.
- Assert normalized event payloads, not only event type names.
- Cover DB-loaded gateway sessions if the provider is exposed through HTTP.
- Add ignored live tests only when they require real provider credentials, and
  keep real keys out of source and logs.
