# node:20 (full Debian) bundles git, curl, ca-certificates, python3, make and
# g++ — everything better-sqlite3 needs — so no apt layer is required.
FROM node:20

# Install the Devin CLI via the official installer. The binary lands in
# /root/.local/bin/devin (a symlink into /root/.local/share). We add that
# to PATH. The CLI carries its own auth — `devin acp` reads credentials
# from `devin auth login` on the host, or from WINDSURF_API_KEY if set.
# No gateway API key is involved.
RUN curl -fsSL https://cli.devin.ai/install.sh | bash
ENV PATH="/root/.local/bin:$PATH"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /data /tmp/devin-workspace

# PORT        — HTTP port the Anthropic Managed Agents server listens on
# WORKDIR     — workspace Devin agents run in (must be a git repo; git-init'd at boot)
# DB_PATH     — SQLite path for durable agent + session bindings
# DEVIN_MODEL — optional default model for every session (fuzzy name e.g. "opus")
# DEVIN_BINARY— override the devin binary path (default: "devin" on PATH)
# Auth: `devin acp` reads credentials from `devin auth login` on the host, or
#        from WINDSURF_API_KEY if set. No gateway API key is involved.
# Credentials mount: mount the host Devin config at /root/.config/devin.
ENV PORT=8080 WORKDIR=/tmp/devin-workspace DB_PATH=/data/agents.db

EXPOSE 8080

CMD ["node", "src/index.mjs"]
