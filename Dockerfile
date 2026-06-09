# syntax=docker/dockerfile:1.7

FROM node:26-bookworm-slim AS ui-builder
WORKDIR /build/src/ui
COPY src/ui/package.json src/ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src/ui/ ./
RUN npm run build

FROM rust:1.90-bookworm AS rust-builder
WORKDIR /build
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY skills ./skills
RUN cargo build --release --bin lite

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=rust-builder /build/target/release/lite /usr/local/bin/lite
COPY --from=ui-builder /build/src/ui/out /app/ui
COPY config.yaml.example /app/config.yaml.example
COPY deploy/render.config.yaml /app/deploy.config.yaml

ENV HOST=0.0.0.0
ENV PORT=4000
ENV LITELLM_CONFIG=/app/config.yaml.example
ENV LITELLM_UI_DIR=/app/ui

EXPOSE 4000
CMD ["lite", "serve", "--host", "0.0.0.0", "--port", "4000", "--config", "/app/config.yaml.example"]
