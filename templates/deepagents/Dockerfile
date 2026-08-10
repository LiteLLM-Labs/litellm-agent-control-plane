FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src

RUN chmod -R a=rX /app \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid 10001 --home-dir /data --shell /bin/sh app \
    && mkdir -p /data \
    && chown -R 10001:10001 /data

ENV PORT=8080 DB_PATH=/data/agents.db DEFAULT_MODEL=anthropic:claude-sonnet-4-5

EXPOSE 8080

USER 10001:10001
CMD ["sh", "-c", "uvicorn src.server:app --host 0.0.0.0 --port ${PORT:-8080}"]
