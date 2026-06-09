# Authentication

The gateway authenticates every request against a single **master key** before
routing it. Auth lives in `proxy/auth/` and runs as the first step of the
`/v1/messages` endpoint.

## Configuring the master key

Set `master_key` under `general_settings` in `config.yaml`:

```yaml
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY   # or a literal string
```

`os.environ/NAME` is expanded from the environment at boot. A literal value
(e.g. `master_key: sk-local`) also works.

> **If `master_key` is not set, the gateway accepts all requests** — no auth.
> Only do this behind your own network boundary.

## Supported header styles

A request may present the key two ways. They are checked in this order:

| Priority | Header | Format | Example |
|---|---|---|---|
| 1 | `Authorization` | `Bearer <key>` | `Authorization: Bearer sk-local` |
| 2 | `x-api-key` | raw key, no prefix | `x-api-key: sk-local` |

If `Authorization: Bearer` is present, it is used. Otherwise the gateway falls
back to `x-api-key`. The `x-api-key` form matches what Anthropic-style clients
(including Claude Code) already send, so they work without extra config.

### Examples

```bash
# Authorization: Bearer
curl http://localhost:4000/v1/messages \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -d '{"model": "claude-sonnet", "messages": [...]}'

# x-api-key
curl http://localhost:4000/v1/messages \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $LITELLM_MASTER_KEY" \
  -d '{"model": "claude-sonnet", "messages": [...]}'
```

## Responses

| Case | Status |
|---|---|
| Key matches (either header) | request proceeds |
| Key wrong or missing (and master key is set) | `401 Unauthorized` |
| No master key configured | request proceeds (auth disabled) |

A `401` returns the standard error body:

```json
{ "error": { "type": "gateway_error", "message": "unauthorized" } }
```

## Note on the upstream provider key

The master key authenticates the **caller to the gateway**. It is separate from
the provider API key (`litellm_params.api_key`) the gateway uses to call the
upstream LLM. Callers never see or send the provider key.
