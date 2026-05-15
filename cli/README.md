# `@berriai/lap-cli`

Command-line client for the LiteLLM Agent Platform. Spins up a sandboxed
Claude Code TUI in your terminal — no browser, no portal, no copy-pasting
URLs. Same feel as `ssh`.

```
~/code/payments $ lap refactor-bot
  ✓ agent refactor-bot (ac70ab02, harness=claude-code)
  ✓ session 8c12262c
  waiting for sandbox. ready
  → attaching local TTY to ws://54.174.239.129:32011/tty

╭───────────────────────────────────────────────────────╮
│   ✻ Welcome to Claude Code                            │
│   cwd:  /work/repo  (acme/payments @ main)            │
│   model: claude-sonnet-4-5  (via LiteLLM gateway)     │
╰───────────────────────────────────────────────────────╯
›
```

## Install

```bash
git clone https://github.com/BerriAI/litellm-agent-platform.git
cd litellm-agent-platform/cli
npm install
chmod +x bin/lap.mjs
ln -sf "$PWD/bin/lap.mjs" /usr/local/bin/lap
```

## First run

```bash
lap login
#   Agent platform URL: https://lap.acme.dev
#   Master key:         ••••••••••••••••
#   ✓ saved to ~/.lap/config.json
```

Config is written to `~/.lap/config.json` with mode `0600`.

## Usage

```bash
lap <agent-name>              # open the agent's TUI in a sandbox
lap --agent <name>            # same as above (flag form)
lap agents                    # list agents on the platform
lap config                    # show current config
lap logout                    # delete config
```

The agent name accepts either a human name or a UUID. Names are resolved
via `GET /api/v1/managed_agents/agents` at session-create time. The
agent's `harness_id` determines which CLI runs inside the sandbox
(`claude-code`, `codex`, …) — you don't have to say.

Press **Ctrl-D** in the attached session to detach. The remote session
stays alive (idle reaper kicks in after 24h with no activity).

## How it works

```
your terminal      lap CLI                LAP API           harness pod
──────────────     ───────                ───────           ───────────
(local PTY)        POST /agents/:id/session ────────────►   spawned
                                                            with auth token
                   poll until status=ready
                   read sandbox_url + tty_token from response

                   WS upgrade  ws://host:port/tty
                   Authorization: Bearer <tty_token>
(raw mode) ◄───►   WebSocket bytes ◄────────────────────► PTY → claude
```

The CLI sets the local terminal to raw mode, opens a WebSocket to the
harness pod's `/tty` endpoint with the bearer token attached as an
`Authorization` header on the upgrade handshake, and pipes bytes both
ways. Resize events (`SIGWINCH`) are forwarded as JSON control messages.
`Ctrl-D` (`0x04`) detaches the local CLI without killing the remote
session.

## Configuration

| File / env var | Purpose |
|---|---|
| `~/.lap/config.json` | base URL + master key, set by `lap login` |
| `LAP_TTY_TOKEN` | override the harness bearer token (normally read from `session.tty_token`) |
| `LAP_TTY_FALLBACK` | fallback WS URL when the platform returns an in-cluster `sandbox_url` (transitional) |

## Security

The harness pod's `/tty` WebSocket requires a bearer token matching
`HARNESS_AUTH_TOKEN` on the pod. The CLI obtains it from
`session.tty_token` in the API response and presents it as an
`Authorization: Bearer <token>` header on the WebSocket upgrade
handshake — **not** in the URL query string — so the token never appears
in ingress, proxy, or load-balancer access logs that record the request
line. The harness rejects every unauthenticated upgrade with `401`
before any PTY spawns; no anonymous shell access is possible.

(The harness also accepts `?token=…` as a fallback because browsers
cannot set arbitrary headers on `new WebSocket(...)`. The CLI is a Node
client and always uses the header form.)

## Source

[`github.com/BerriAI/litellm-agent-platform/cli`](https://github.com/BerriAI/litellm-agent-platform/tree/main/cli)
