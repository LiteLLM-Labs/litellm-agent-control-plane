# Debugging

## Enable debug logs

Set `RUST_LOG` before starting the proxy:

```bash
RUST_LOG=litellm_rust=debug ./target/debug/lite --config config.yaml
```

For trace-level output (very verbose):

```bash
RUST_LOG=litellm_rust=trace ./target/debug/lite --config config.yaml
```

## Router resolution

Every request logs how the incoming model name was resolved to an upstream deployment.

**Exact match** — model name matched a named route in `model_list`:
```
router: exact match  model="claude" upstream_model="claude-sonnet-4-5" provider="anthropic"
```

**Wildcard match** — no exact match; fell through to the `/*` wildcard route. Provider prefix stripped if present:
```
router: wildcard match — stripped provider prefix  model="anthropic/claude-opus-4-8" upstream_model="claude-opus-4-8" provider="anthropic"
```

**No route** — no exact match and no wildcard configured:
```
router: no exact match and no wildcard route  model="gpt-4o"
```

Resolution is a single O(1) HashMap lookup — there is no retrying or brute-forcing.

## Model cost map

On startup the proxy fetches the LiteLLM model pricing sheet. If the fetch fails it falls back to an embedded backup:

```
WARN Failed to fetch model cost map from https://... — using backup
```

If both fail (parse error, network issue), the proxy continues with an empty cost map and logs:
```
ERROR Failed to parse embedded backup model cost map: ...
```

Pricing data is used for cost tracking only — the proxy still routes requests normally with an empty map.

## Config validation errors

Bad config exits immediately with a descriptive message:

| Error | Cause |
|---|---|
| `model must include provider prefix` | `litellm_params.model` missing `provider/` prefix |
| `model missing name after provider prefix` | `litellm_params.model` set to just `anthropic/` |
| `unsupported provider: <id>` | Provider not registered (e.g. typo) |
| `missing litellm_params.api_key` | No API key for that model entry |
| `only one wildcard model route is supported` | More than one `/*` entry in `model_list` |
