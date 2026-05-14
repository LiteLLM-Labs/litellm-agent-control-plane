# claude-tty POC

Smallest possible "Claude Code in a sandbox" — a Docker container that
runs `claude` under a PTY and bridges it to a browser terminal over
WebSocket. ~80 lines of glue.

```
Browser (xterm.js)  ◀── ws ──▶  bridge (node, this image)  ◀── pty ──▶  claude
```

## Run

```bash
docker build -t claude-tty-poc .

# With your Anthropic key:
docker run --rm -p 4096:4096 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  claude-tty-poc

# Or against your LiteLLM gateway:
docker run --rm -p 4096:4096 \
  -e ANTHROPIC_BASE_URL=https://litellm.acme.dev \
  -e ANTHROPIC_AUTH_TOKEN=$LITELLM_API_KEY \
  claude-tty-poc

# Or clone a repo into the working dir first:
docker run --rm -p 4096:4096 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e REPO_URL=https://github.com/BerriAI/litellm \
  -e REPO_BRANCH=main \
  claude-tty-poc
```

Open <http://localhost:4096>. You should see the Claude Code welcome
banner, type a prompt, and watch it work.

## Testing the bridge without an API key

Override the command to bash — no LLM needed:

```bash
docker run --rm -p 4096:4096 -e POC_CMD=bash claude-tty-poc
```

Type `ls`, `top`, `vim foo.txt` — anything that uses ANSI / cursor
movement. If those render correctly, the PTY bridge is sound and
swapping to `claude` is a one-env-var change.

## What this is and isn't

- **Is**: the terminal-streaming half of the LAP "TUI harness" idea.
  Proves xterm.js + node-pty + ws is the right plumbing.
- **Isn't**: vault, repo isolation policy, K8s NetworkPolicy, multi-session,
  auth. Those layers live in LAP itself and don't change how the terminal
  bridge works — they wrap around it.

## Files

- `Dockerfile`        — node:20-slim + claude CLI + node-pty
- `server.js`         — ~70 LOC: http static + ws on /tty + pty.spawn
- `public/index.html` — xterm.js page, addon-fit, addon-web-links
- `entrypoint.sh`     — optional `git clone $REPO_URL` then exec node
