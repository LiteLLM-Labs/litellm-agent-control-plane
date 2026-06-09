# Coding Standards

This repo is a low-overhead gateway. Keep the code explicit, boring, and easy
to profile.

## Architecture

- Core gateway behavior lives under `src/ai_gateway/`. HTTP is only one
  adapter into that core.
- HTTP handlers only do protocol work: auth, body extraction, response shaping.
- Model lookup and provider calls live in `llms/`.
- Provider request/response shape changes live behind `MessagesTransformation`;
  every provider owns its own transformation implementation.
- Provider detection follows the LiteLLM `provider/model` convention through
  `get_custom_llm_provider`.
- SDK-style gateway entrypoints use request/response structs under
  `src/ai_gateway/`; HTTP routes call those entrypoints instead of duplicating
  gateway logic.
- Config parsing lives in `config/`; never read env vars or YAML from handlers.
- Add a provider by adding a provider module, not by branching through the app.
- Provider-shared flows must stay provider-generic. Credential storage, CRUD
  routes, catalog/listing, routing overrides, and UI client helpers should key
  off `provider_id` and provider metadata, not hardcoded provider names such as
  `save_anthropic` or `/api/providers/anthropic`. Keep provider-specific
  behavior in catalog entries or provider modules.
- Prefer boot-time validation over runtime surprises.

## Performance

- Reuse one HTTP client from `AppState`; never create clients per request or
  as throwaway bootstraps. If HTTP is needed before `AppState` exists (e.g.
  a startup fetch), build the client first via `AppState::build_http_client()`,
  use it for the early call, then pass it into `AppState::new()` — so proxy
  settings, CA certs, and pool config apply everywhere automatically.
- Parse request JSON once. Re-serialize only when the upstream model must be
  rewritten from a public alias.
- Streaming responses are byte passthrough. Do not parse SSE chunks on the hot
  path unless a feature explicitly requires it.
- Add callbacks around the transformation/client boundary, not inside provider
  transformation code. Providers should translate protocol shape; callbacks
  should observe or post-process traffic.
- Keep middleware minimal and measurable.
- Avoid heap-heavy abstractions in request routing. Clear functions beat clever
  generic frameworks here.

## Comments

- Write no comments by default. Well-named identifiers are the documentation.
- Add a comment only when the WHY is non-obvious: a hidden constraint, a subtle
  invariant, a bug workaround, or behavior that would surprise a reader.
- Never describe WHAT the code does — that's the code's job.
- Never reference the current task, fix, or caller ("added for X flow", "fixes
  issue #123") — those belong in commit messages and rot as code evolves.
- If removing the comment wouldn't confuse a future reader, don't write it.

## Rust Style

- Modules are small and named by responsibility.
- Public types have narrow fields and no `serde_json::Value` escape hatches
  unless the endpoint is intentionally pass-through.
- Errors use typed enums and map to HTTP responses in one place.
- No `unwrap()` or `expect()` in request paths.
- Tests cover config resolution, auth, non-stream forwarding, and streaming
  forwarding before adding new behavior.

## Repository Root

- Root is for project-level artifacts only: `Cargo.toml`, `Cargo.lock`,
  `build.rs`, `README.md`, `LICENSE`, `config.yaml.example`, `AGENTS.md`,
  `CODING_STANDARDS.md`.
- Do not add new files to root. New source goes under `src/`, docs under
  `docs/`, tests under `tests/`.
- Config examples belong in `config.yaml.example`; never commit real secrets
  or a personal `config.yaml` to root.
- If a tool or script is needed, put it under `scripts/` or `docs/` — not
  root.
- When unsure where a file belongs, default to a subdirectory. Keep root clean
  so the project shape is obvious at a glance.

## Compatibility

- `config.yaml` should remain LiteLLM-compatible where possible.
- v0 supports Anthropic only. Unsupported providers must fail at boot with a
  clear message.
- `/v1/messages` is the first stable route. Add new routes behind focused
  modules and tests.
