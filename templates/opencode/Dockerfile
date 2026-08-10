# node:20 (full Debian) already bundles git, curl, ca-certificates, python3,
# make and g++ — everything opencode and better-sqlite3 need — so no apt layer.
FROM node:20

# Install the opencode CLI via the official installer (detects arch + libc;
# works on both arm64 and amd64, unlike the npm package's optionalDeps).
RUN curl -fsSL https://opencode.ai/install | bash
RUN install -m 0755 /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && rm -rf /root/.opencode

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

RUN chmod -R a=rX /app \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid 10001 --home-dir /data --shell /bin/sh app \
    && mkdir -p /data /tmp/opencode-workspace \
    && chown -R 10001:10001 /data /tmp/opencode-workspace

ENV HOME=/data PORT=8080 OPENCODE_PORT=4096 WORKDIR=/tmp/opencode-workspace DB_PATH=/data/agents.db

EXPOSE 8080

USER 10001:10001
CMD ["node", "src/index.mjs"]
