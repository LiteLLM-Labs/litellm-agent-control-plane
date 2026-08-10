# Codex app-server runtime

This template exposes the Codex CLI app-server through the Anthropic Managed
Agents API used by LiteLLM Agent Control Plane. One bridge service can host
multiple isolated Codex profiles:

- `api` uses an OpenAI Responses-compatible base URL, API key, and model.
- `chatgpt` uses Codex's native ChatGPT device authorization and persisted
  `CODEX_HOME`; it does not require an OpenAI API key.
- `remote_ssh` starts `codex app-server --listen stdio://` over SSH on another
  machine, using either a password or private key.

Each profile has its own agent/session database, Codex home, and workspace.
Profile secrets are encrypted at rest with AES-256-GCM. `PROFILE_ENCRYPTION_KEY`
is the preferred encryption secret; when omitted, `RUNTIME_API_KEY` is used.
The legacy root API remains available for existing deployments and sessions.

## Run locally

```bash
docker build -t lap-codex-runtime .
docker run --rm -p 8080:8080 \
  -e MODEL_BASE_URL=https://api.openai.com/v1 \
  -e MODEL_API_KEY="$OPENAI_API_KEY" \
  -e DEFAULT_MODEL=gpt-5.6-sol-high \
  -e RUNTIME_API_KEY=change-me \
  -v codex-runtime-data:/data \
  -v codex-runtime-home:/codex-home \
  lap-codex-runtime
```

`MODEL_BASE_URL` may include `/v1`; it is appended when omitted. The same
settings can use the aliases `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and
`LITELLM_DEFAULT_MODEL`. `RUNTIME_API_KEY` protects the runtime HTTP API and is
separate from the model provider credential.

Agents that use LAP platform MCPs, including `list_sub_agents` and
`run_sub_agent`, also require `LAP_GATEWAY_API_KEY` and
`LAP_GATEWAY_MCP_BASE_URL`. The bridge exposes the key to Codex only by
environment-variable name and only for a `platform` MCP URL on that trusted
base URL; the credential value is never copied into thread configuration.
`LAP_GATEWAY_MCP_INTERNAL_BASE_URL` may point platform MCP traffic at a private
control-plane address so long-running sub-agent calls do not cross a public
reverse proxy; the original public URL is still validated against the trusted
base before it is rewritten.
Threads with the LAP platform MCP disable Codex's native collaboration tools,
so configured LAP sub-agents remain the authoritative orchestration path.
Platform MCP tool calls have a 31-minute client timeout. LAP waits up to 30
minutes for a child session to finish, leaving a one-minute margin so LAP can
return the terminal result before Codex treats the transport as failed.

In LAP, register this root endpoint once as the Codex app-server controller.
The Runtimes page then creates API, ChatGPT, and Remote SSH profiles through the
controller. LAP keeps the controller key server-side and never returns profile
secrets to the browser. ChatGPT sign-in is completed from the profile's runtime
details using the displayed verification URL and one-time device code.

Remote SSH executes a fixed command that creates and enters the configured
workspace before starting app-server. The first successful connection records
the observed host-key fingerprint (trust on first use); supplying a fingerprint
up front enforces it immediately. Subsequent restarts enforce the stored pin.

Verify a running instance with:

```bash
BASE=http://localhost:8080 RUNTIME_API_KEY=change-me MODEL=gpt-5.6-sol-high ./scripts/smoke.sh
```

The container pins Codex CLI because app-server is an experimental protocol.
Upgrade the `CODEX_CLI_VERSION` build argument only after the unit and smoke
tests pass against the new version.
