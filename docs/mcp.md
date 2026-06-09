# MCP Support

litellm-rust acts as an MCP gateway — it forwards requests from AI clients to your MCP servers, injecting upstream auth along the way. The config is **LiteLLM-compatible**: the `mcp_servers` block uses the same dict-keyed shape as the LiteLLM Python proxy, so an existing LiteLLM MCP config drops in for the supported cases.

## Quick Start

**1. Add servers to `config.yaml`** (keyed by server name):

```yaml
mcp_servers:
  proxy_base_url: https://your-gateway.example.com
  linear:
    url: https://mcp.linear.app/mcp
    auth_type: bearer_token
    auth_value: os.environ/LINEAR_MCP_API_KEY
```

**2. Start the gateway, then point your client at:**

```
http://localhost:4000/mcp/linear
```

A public server needs no auth at all:

```yaml
mcp_servers:
  deepwiki_mcp:
    url: https://mcp.deepwiki.com/mcp
```

`proxy_base_url` is only needed when the gateway exposes its own platform MCPs
to cloud runtimes such as Claude Managed Agents. It must be the public base URL
of this gateway, for example `https://your-gateway.example.com`. It can also use
env expansion:

```yaml
mcp_servers:
  proxy_base_url: os.environ/LITELLM_PROXY_BASE_URL
```

You can also set or override this value from the **MCP Servers** page in the
gateway UI.

---

## How Do I Call It?

Two endpoints:

| Endpoint | When to use |
|---|---|
| `/mcp/{server_name}` | Target one server by its config key |
| `/mcp` | Single-server configs — gateway auto-selects. With >1 server, send `x-litellm-mcp-server: <name>` or `?server=<name>` |

All requests need your gateway master key:

```
Authorization: Bearer your-master-key
```

Methods: `GET`, `POST`, `DELETE` (streamable HTTP transport).

---

## Authentication

`auth_type` + `auth_value` map to an upstream header exactly as LiteLLM's managed transport does:

| `auth_type` | Header sent upstream |
|---|---|
| `none` (default) | *(no auth header)* |
| `api_key` | `X-API-Key: <auth_value>` |
| `bearer_token` | `Authorization: Bearer <auth_value>` |
| `basic` | `Authorization: Basic <base64(auth_value)>` |
| `authorization` | `Authorization: <auth_value>` (verbatim) |
| `token` | `Authorization: token <auth_value>` |

`auth_value` accepts `os.environ/VAR` expansion. The alias `authentication_token` is also accepted (matches LiteLLM).

### Extra headers

```yaml
mcp_servers:
  docs:
    url: https://mcp.example.com/mcp
    static_headers:            # always sent upstream
      x-workspace: prod
    extra_headers:             # names of inbound request headers to forward
      - x-trace-id
```

- `static_headers` — fixed key/value pairs always sent upstream (override auth/forwarded on conflict).
- `extra_headers` — a list of inbound header **names** the gateway forwards from the client request. Credential headers (`authorization`, `x-api-key`, `x-litellm-*`) are **never** forwarded, even if listed, so your gateway master key cannot leak to a third-party server.

---

## Claude Code SDK Example

```js
import { query } from "@anthropic-ai/claude-code";

for await (const msg of query({
  prompt: "List available tools",
  options: {
    mcpServers: {
      gateway: {
        type: "http",
        url: "http://localhost:4000/mcp/linear",
        headers: { Authorization: "Bearer your-master-key" },
      },
    },
  },
})) {
  console.log(msg);
}
```

---

## Known gaps vs LiteLLM

These LiteLLM features are **not yet supported**. Where a config uses them, the gateway fails fast (config error or a loud startup warning) rather than misbehaving silently:

- **Multi-server aggregation behind a single `/mcp`.** LiteLLM merges every server's tools behind one endpoint; litellm-rust serves one server per request. Target `/mcp/{name}` (or send `x-litellm-mcp-server` / `?server=`). A multi-server config logs a startup warning.
- **Per-request upstream creds via `x-mcp-{server}-{header}`.** Configure `auth_value` server-side instead.
- **`oauth2`, `oauth2_token_exchange`, `aws_sigv4` auth types** — rejected at config load.
- **`sse` and `stdio` transports** — only `http` (streamable HTTP) is served; others rejected at config load.

---

## FAQ

**Environment variables in config?**

```yaml
mcp_servers:
  linear:
    url: os.environ/LINEAR_MCP_URL
    auth_type: bearer_token
    auth_value: os.environ/LINEAR_MCP_API_KEY
```
`url`, `auth_value`, and `static_headers` values all support `os.environ/VAR`.
`proxy_base_url` supports the same expansion. If it is omitted, the gateway falls
back to `LITELLM_PROXY_BASE_URL`, then the legacy `LITELLM_PUBLIC_BASE_URL`, then
`RENDER_EXTERNAL_URL`.

**I'm upgrading from the old list format and get a config error.**
`mcp_servers` changed from a list (`- id: x`) to a dict keyed by server name (`x:`). Move the `id` up to the map key and rename `api_key`→`auth_value` (+ set `auth_type`), `headers`→`static_headers`.

**Does the gateway read MCP messages?**
No. Pure pass-through — JSON-RPC is handled by the upstream and client. The gateway only handles routing + auth.
