# node:20 (full Debian) bundles git, curl, ca-certificates, python3, make and
# g++ — everything better-sqlite3 needs — so no apt layer is required.
FROM node:20

# Install the Devin CLI via the official installer into /usr/local/bin so it
# is on PATH for any user. The CLI carries its own auth — `devin acp` reads
# credentials from `devin auth login` on the host, or from WINDSURF_API_KEY
# if set. No gateway API key is involved.
RUN curl -fsSL https://cli.devin.ai/install.sh | bash \
    && mv /root/.local/bin/devin /usr/local/bin/devin 2>/dev/null || true

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /data /tmp/devin-workspace \
    && chown -R node:node /app /data /tmp/devin-workspace

# PORT        — HTTP port the Anthropic Managed Agents server listens on
# WORKDIR     — workspace Devin agents run in (must be a git repo; git-init'd at boot)
# DB_PATH     — SQLite path for durable agent + session bindings
# DEVIN_MODEL — optional default model for every session (fuzzy name e.g. "opus")
# DEVIN_BINARY— override the devin binary path (default: "devin" on PATH)
# Auth: `devin acp` reads credentials from `devin auth login` on the host, or
#        from WINDSURF_API_KEY if set. No gateway API key is involved.
# Credentials mount: when running as `node`, mount the host Devin config at
#        /home/node/.config/devin (not /root/.config/devin).
ENV PORT=8080 WORKDIR=/tmp/devin-workspace DB_PATH=/data/agents.db

EXPOSE 8080

USER node

CMD ["node", "src/index.mjs"]
