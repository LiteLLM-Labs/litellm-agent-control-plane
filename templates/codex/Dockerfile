FROM node:20

ARG CODEX_CLI_VERSION=0.146.0
ARG REPORTLAB_VERSION=4.5.1
ARG PYMUPDF_VERSION=1.28.2
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bubblewrap \
      ca-certificates \
      curl \
      file \
      fontconfig \
      fonts-dejavu-core \
      git \
      jq \
      poppler-utils \
      procps \
      python3 \
      python3-venv \
      ripgrep \
      unzip \
      zip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/codex-tools \
    && /opt/codex-tools/bin/pip install --no-cache-dir \
      "reportlab==${REPORTLAB_VERSION}" \
      "PyMuPDF==${PYMUPDF_VERSION}" \
    && /opt/codex-tools/bin/python -c "import pymupdf, reportlab" \
    && npm install --global "@openai/codex@${CODEX_CLI_VERSION}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts/verify-platform-routing.mjs ./scripts/verify-platform-routing.mjs
RUN node scripts/verify-platform-routing.mjs

RUN chmod -R a=rX /app \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid 10001 --home-dir /codex-home --shell /bin/sh app \
    && mkdir -p /data /workspace /codex-home \
    && chown -R 10001:10001 /data /workspace /codex-home

ENV PORT=8080 \
    DB_PATH=/data/agents.db \
    WORKSPACE_ROOT=/workspace \
    CODEX_HOME=/codex-home \
    CODEX_LOCAL_PERMISSION_PROFILE=:danger-full-access \
    PATH=/opt/codex-tools/bin:${PATH} \
    DEFAULT_MODEL=gpt-5.6-sol-high

EXPOSE 8080
USER 10001:10001
CMD ["node", "src/index.mjs"]
