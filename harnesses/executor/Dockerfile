# syntax=docker/dockerfile:1.7
#
# Executor harness — minimal HTTP command-executor for the brain-inline
# architecture.  Same tool surface as the other harnesses (Playwright, gh,
# git, npm, node, python, uv, etc.) but the running process is a simple
# Hono server that accepts shell commands, not a full AI agent binary.
#
# No claude-agent-sdk, no opencode, no managed-tools dependency.
#
# Build from repo root:
#   docker buildx build -f harnesses/base/Dockerfile -t harnesses/base:dev . && \
#   docker buildx build -f harnesses/executor/Dockerfile -t executor-sandbox:dev .

FROM node:20-bookworm AS builder

# Executor server — path mirrors the source layout (harnesses/executor/) so
# the tsconfig rootDir/outDir resolution works without adjustment.
WORKDIR /build/harnesses/executor
COPY harnesses/executor/package.json harnesses/executor/tsconfig.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps
COPY harnesses/executor/src ./src
RUN npx tsc

# ------------------------------------------------------------------ runtime
FROM harnesses/base:dev

# Executor server — production node_modules only (no tsc / @types).
# Path depth mirrors the source tree so any relative imports in dist/ resolve.
WORKDIR /opt/harnesses/executor
COPY --from=builder /build/harnesses/executor/package.json ./
COPY --from=builder /build/harnesses/executor/dist ./dist

# Playwright browsers — same pattern as claude-agent-sdk harness.
# Pin browsers to /opt/ms-playwright so the sandbox user can read them;
# chromium system libs are already present in harnesses/base.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps \
    && npx --no-install playwright install chromium \
    && chown -R sandbox:sandbox /opt/harnesses /opt/ms-playwright

WORKDIR /work

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

USER sandbox
EXPOSE 4096
CMD ["node", "/opt/harnesses/executor/dist/server.js"]
