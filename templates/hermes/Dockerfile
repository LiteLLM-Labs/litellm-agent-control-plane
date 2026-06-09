FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    ffmpeg \
    git \
    nodejs \
    npm \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/hermes-agent
RUN git clone --depth 1 https://github.com/NousResearch/hermes-agent.git . \
  && pip install --no-cache-dir ".[anthropic,cli,mcp]"

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src

RUN mkdir -p /data /tmp/hermes-workspace

ENV PORT=8080 \
  DB_PATH=/data/agents.db \
  DEFAULT_MODEL=anthropic/claude-sonnet-4-5 \
  HERMES_HOME_ROOT=/data/hermes-home \
  HERMES_WORKDIR=/tmp/hermes-workspace \
  HERMES_TOOLSETS=terminal,web

EXPOSE 8080

CMD ["sh", "-c", "uvicorn src.server:app --host 0.0.0.0 --port ${PORT:-8080}"]
