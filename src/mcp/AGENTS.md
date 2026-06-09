Keep this folder minimal for v0. MCP config is parsed by the existing
`proxy::config` loader using LiteLLM's dict-keyed `mcp_servers` shape, and the
only supported transport is streamable HTTP pass-through.

Auth: each server's `auth_type` + `auth_value` is resolved once at config time
into a single upstream header in `registry::build_auth_header` (LiteLLM's
managed-transport table — note `api_key` → `X-API-Key`, not bearer). The request
path only copies the precomputed header. `static_headers` are always sent;
`extra_headers` forwards named inbound headers but never credential headers
(`authorization`/`x-api-key`/`x-litellm-*`), so the gateway master key cannot
leak upstream.

Deferred (rejected loudly, not silently): `oauth2`/`oauth2_token_exchange`/
`aws_sigv4` auth, `sse`/`stdio` transports, multi-server aggregation behind a
bare `/mcp`, and per-request client creds via `x-mcp-{server}-{header}`.
