#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-opencode}"
URL="http://localhost:4000"
ONBOARDING="${URL}/onboarding"

echo "Starting LiteLLM Agent Platform (profile: ${PROFILE})..."
docker compose --profile "${PROFILE}" up -d --build

MASTER_KEY="${LITELLM_MASTER_KEY:-sk-local}"

echo "Waiting for server at ${URL}..."
until curl -fsS "${URL}/whoami" -H "Authorization: Bearer ${MASTER_KEY}" >/dev/null 2>&1; do
  sleep 1
done

echo "Server ready. Opening onboarding..."

case "$(uname -s)" in
  Darwin)  open "${ONBOARDING}" ;;
  Linux)   xdg-open "${ONBOARDING}" 2>/dev/null || echo "Open ${ONBOARDING}" ;;
  CYGWIN*|MINGW*|MSYS*) start "${ONBOARDING}" ;;
  *)       echo "Open ${ONBOARDING}" ;;
esac

echo ""
echo "  ${ONBOARDING}"
echo ""
echo "Default master key: sk-local"
echo "Logs: docker compose --profile ${PROFILE} logs -f"
