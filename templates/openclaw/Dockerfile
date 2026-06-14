FROM node:22-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    python3 \
    python3-venv \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@latest

COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /data

ENV PATH=/opt/venv/bin:$PATH \
  CHROME_BIN=/usr/bin/chromium \
  HOME=/data \
  PORT=8080 \
  DB_PATH=/data/agents.db \
  DEFAULT_MODEL=openclaw/default \
  OPENCLAW_PORT=18789 \
  OPENCLAW_BASE_URL=http://127.0.0.1:18789/v1 \
  OPENCLAW_AGENT_MODEL=litellm/claude-sonnet-4-6 \
  LITELLM_BASE_URL=http://127.0.0.1:4000/v1

EXPOSE 8080

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
