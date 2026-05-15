# opencode harness
#
# Build from repo root:
#   docker buildx build -f harnesses/opencode/Dockerfile -t opencode-sandbox:dev .

# ------------------------------------------------------------------ installer
FROM debian:bookworm-slim AS installer

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://opencode.ai/install | bash

# Drop install bundles / caches if any
RUN find /root/.opencode -maxdepth 2 -type d -name 'cache' -exec rm -rf {} + 2>/dev/null || true \
 && find /root/.opencode -maxdepth 2 -name '*.zip' -delete 2>/dev/null || true \
 && find /root/.opencode -maxdepth 2 -name '*.tar*' -delete 2>/dev/null || true

# ------------------------------------------------------------------ runtime
FROM debian:bookworm-slim

# gh CLI: pinned release + SHA-256 (no `curl | bash`, no unversioned URLs).
# To bump: update both ARGs together. SHA-256 is from the official
# gh_<version>_checksums.txt file alongside the release.
ARG GH_VERSION=2.92.0
ARG GH_SHA256=8f8212b1a9cec261a8839e0893168f50d3fc70f095da257feef4229234cefdf8

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates bash python3 curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /tmp/gh.deb \
         "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.deb" \
    && echo "${GH_SHA256}  /tmp/gh.deb" | sha256sum -c - \
    && dpkg -i /tmp/gh.deb \
    && rm /tmp/gh.deb \
    && useradd -m -u 1000 -s /bin/bash sandbox \
    && mkdir -p /work \
    && chown sandbox:sandbox /work

COPY --from=installer --chown=sandbox:sandbox /root/.opencode /home/sandbox/.opencode
ENV PATH="/home/sandbox/.opencode/bin:${PATH}"

WORKDIR /work

COPY harnesses/_shared/entrypoint-common.sh /opt/lap/common.sh
RUN chmod +x /opt/lap/common.sh

COPY --chown=sandbox:sandbox harnesses/opencode/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER sandbox

EXPOSE 4096
ENTRYPOINT ["/entrypoint.sh"]
