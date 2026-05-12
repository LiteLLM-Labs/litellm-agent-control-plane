#!/bin/sh
# Write ~/.claude/settings.json from runtime env vars so the claude binary
# can auth through the LiteLLM proxy without needing the host's ~/.claude.
mkdir -p ~/.claude
cat > ~/.claude/settings.json << EOF
{"env":{"ANTHROPIC_BASE_URL":"${LITELLM_API_BASE%/}","ANTHROPIC_AUTH_TOKEN":"${LITELLM_API_KEY}","ANTHROPIC_API_KEY":"${LITELLM_API_KEY}"}}
EOF

exec node /home/agent/dist/server.js
