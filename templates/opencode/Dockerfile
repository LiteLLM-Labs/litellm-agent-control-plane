# node:20 (full Debian) already bundles git, curl, ca-certificates, python3,
# make and g++ — everything opencode and better-sqlite3 need — so no apt layer.
FROM node:20

# Install the opencode CLI via the official installer (detects arch + libc;
# works on both arm64 and amd64, unlike the npm package's optionalDeps).
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:$PATH"

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /data /tmp/opencode-workspace

ENV PORT=8080 OPENCODE_PORT=4096 WORKDIR=/tmp/opencode-workspace DB_PATH=/data/agents.db

EXPOSE 8080

CMD ["node", "src/index.mjs"]
