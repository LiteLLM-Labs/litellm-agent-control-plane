# Templates

Runtime templates for LAP. Each `templates/<name>/` is a self-contained server
that wraps an AI agent runtime (e.g. Deep Agents, Hermes, OpenCode) behind the
**Anthropic Managed Agents API spec**. Once deployed, LAP drives it like any
other runtime — point a runtime's `api_base`/`api_key` at the server, no
LAP code changes.

- **Install targets:** [`manifest.json`](./manifest.json) lists every template LAP can install.
- **Add a new one:** use the `create-harness` skill — see [`AGENTS.md`](./AGENTS.md).
