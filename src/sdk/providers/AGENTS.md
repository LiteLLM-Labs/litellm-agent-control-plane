# Provider SDK Instructions

These instructions apply to provider code under `src/sdk/providers/`.

## Endpoint module boundaries

Provider endpoint code is organized by the public endpoint shape being adapted,
not by the upstream endpoint it eventually calls.

- Anthropic Messages-compatible request/response translation belongs in
  `<provider>/anthropic_messages/`.
- OpenAI Responses-native request/response behavior belongs in
  `<provider>/openai_responses/`.
- If a provider supports Anthropic Messages by translating to a different
  upstream endpoint, the adapter still belongs in
  `<provider>/anthropic_messages/`.
- Anthropic Messages adapters must implement or use
  `BaseAnthropicMessagesTransformation`.
- Do not put Anthropic Messages translation helpers in
  `<provider>/openai_responses/`; that module is for native Responses behavior.

## Provider registration

Endpoint folders with `transformation.rs` are endpoint adapters. Only endpoint
modules exposing `init` should be registered as provider roots.

When adding an adapter-only endpoint folder, keep provider registration in the
provider's existing registration module and make the adapter delegate through
the appropriate base endpoint trait.

## Structure checks

`tests/sdk_structure.rs::sdk_tree_matches_provider_endpoint_contract` enforces
the provider tree shape. Run it after changing provider folders:

```bash
cargo test --test sdk_structure
```
