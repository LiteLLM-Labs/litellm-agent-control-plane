# Contributing

## Prerequisites

- Rust toolchain — [rustup.rs](https://rustup.rs)
- An Anthropic API key (for end-to-end testing)

## Run the server locally

**1. Clone and build**

```bash
git clone <repo>
cd litellm-rust
cargo build
```

**2. Create a config**

```bash
cp config.yaml.example config.yaml
```

`config.yaml.example` ships with a single Anthropic model entry. The `api_key`
and `master_key` fields read from environment variables by default:

```yaml
model_list:
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-5
      api_key: os.environ/ANTHROPIC_API_KEY

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

**3. Start the server**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export LITELLM_MASTER_KEY=sk-mykey

cargo run -- --config config.yaml
```

Server listens on `http://localhost:4000` by default.

**4. Verify**

```bash
# Health check
curl http://localhost:4000/health

# Chat request
curl -X POST http://localhost:4000/v1/messages \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet", "messages": [{"role": "user", "content": "hello"}], "max_tokens": 10}'
```

The proxy exposes `/v1/messages` (Anthropic-native protocol). There is no
`/v1/chat/completions` (OpenAI-compat) route yet.

## Run tests

```bash
cargo test
```

Integration tests in `tests/` spin up a local wiremock server — no real API
calls needed.

## Add a provider

Drop a new folder under `src/sdk/providers/`:

```
src/sdk/providers/openai/
├── mod.rs
└── openai_responses/
    ├── mod.rs              # pub fn init(registry) { registry.register("openai", ...) }
    └── transformation.rs   # impl Transformation
```

`build.rs` auto-discovers the folder and wires it in. No other files need
editing. See `src/sdk/providers/anthropic/anthropic_messages/` for a reference implementation.

## Project layout

```
src/
  sdk/
    routing.rs # request/model routing above provider endpoint transformation
    providers/
      base/ # endpoint-family base traits + runtime adapter base trait
      <provider>/<endpoint>/ # provider-owned endpoint/ and runtime/ modules
    agents/    # Agent Runtime SDK client resources + types
  proxy/       # config, master-key auth, AppState
  http/        # axum endpoints + outbound HTTP (http/llm.rs)
  cli/         # CLI wizard
  errors.rs    # shared GatewayError
```

See [architecture.md](architecture.md) for the full request flow.
