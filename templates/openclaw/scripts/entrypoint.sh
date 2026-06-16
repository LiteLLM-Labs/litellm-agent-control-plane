#!/bin/sh
set -eu

OPENCLAW_PORT="${OPENCLAW_PORT:-18789}"
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-${OPENCLAW_API_KEY:-local-openclaw-token}}"
OPENCLAW_AGENT_ID="${OPENCLAW_AGENT_ID:-dev}"
OPENCLAW_AGENT_MODEL="${OPENCLAW_AGENT_MODEL:-litellm/claude-sonnet-4-6}"
OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace-dev}"
OPENCLAW_MEMORY_PROVIDER="${OPENCLAW_MEMORY_PROVIDER:-none}"
OPENCLAW_MEMORY_MODEL="${OPENCLAW_MEMORY_MODEL:-}"
OPENCLAW_SEED_RUNTIME_MEMORY="${OPENCLAW_SEED_RUNTIME_MEMORY:-1}"
LITELLM_BASE_URL="${LITELLM_BASE_URL:-http://127.0.0.1:4000/v1}"
LITELLM_API_KEY="${LITELLM_API_KEY:-}"
LITELLM_PROVIDER_ID="${LITELLM_PROVIDER_ID:-litellm}"
LITELLM_PROVIDER_API="${LITELLM_PROVIDER_API:-anthropic-messages}"
LITELLM_MODELS="${LITELLM_MODELS:-claude-sonnet-4-6}"
OPENCLAW_BROWSER_ON_BOOT="${OPENCLAW_BROWSER_ON_BOOT:-1}"
OPENCLAW_BROWSER_EXECUTABLE_PATH="${OPENCLAW_BROWSER_EXECUTABLE_PATH:-/usr/bin/chromium}"
OPENCLAW_BROWSER_HEADLESS="${OPENCLAW_BROWSER_HEADLESS:-1}"
OPENCLAW_BROWSER_NO_SANDBOX="${OPENCLAW_BROWSER_NO_SANDBOX:-1}"
OPENCLAW_BROWSER_ALLOW_PRIVATE_NETWORK="${OPENCLAW_BROWSER_ALLOW_PRIVATE_NETWORK:-1}"
OPENCLAW_BROWSER_LAUNCH_TIMEOUT_MS="${OPENCLAW_BROWSER_LAUNCH_TIMEOUT_MS:-30000}"
OPENCLAW_BROWSER_CDP_READY_TIMEOUT_MS="${OPENCLAW_BROWSER_CDP_READY_TIMEOUT_MS:-30000}"
OPENCLAW_MEMORY_INDEX_ON_BOOT="${OPENCLAW_MEMORY_INDEX_ON_BOOT:-1}"
OPENCLAW_BOOT_TASK_TIMEOUT_SECONDS="${OPENCLAW_BOOT_TASK_TIMEOUT_SECONDS:-30}"

export OPENCLAW_PORT
export OPENCLAW_GATEWAY_TOKEN
export OPENCLAW_AGENT_ID
export OPENCLAW_AGENT_MODEL
export OPENCLAW_WORKSPACE
export OPENCLAW_MEMORY_PROVIDER
export OPENCLAW_MEMORY_MODEL
export OPENCLAW_SEED_RUNTIME_MEMORY
export OPENCLAW_BROWSER_ON_BOOT
export OPENCLAW_BROWSER_EXECUTABLE_PATH
export OPENCLAW_BROWSER_HEADLESS
export OPENCLAW_BROWSER_NO_SANDBOX
export OPENCLAW_BROWSER_ALLOW_PRIVATE_NETWORK
export OPENCLAW_BROWSER_LAUNCH_TIMEOUT_MS
export OPENCLAW_BROWSER_CDP_READY_TIMEOUT_MS
export OPENCLAW_MEMORY_INDEX_ON_BOOT
export OPENCLAW_BOOT_TASK_TIMEOUT_SECONDS
export LITELLM_BASE_URL
export LITELLM_API_KEY
export LITELLM_PROVIDER_ID
export LITELLM_PROVIDER_API
export LITELLM_MODELS
export OPENCLAW_BASE_URL="${OPENCLAW_BASE_URL:-http://127.0.0.1:${OPENCLAW_PORT}/v1}"
export OPENCLAW_API_KEY="$OPENCLAW_GATEWAY_TOKEN"

python3 - <<'PY'
import json
import os
from pathlib import Path

home = Path(os.environ["HOME"])
config_dir = home / ".openclaw"
workspace = Path(os.environ["OPENCLAW_WORKSPACE"])
memory_dir = workspace / "memory"
config_dir.mkdir(parents=True, exist_ok=True)
workspace.mkdir(parents=True, exist_ok=True)
memory_dir.mkdir(parents=True, exist_ok=True)

if os.environ.get("OPENCLAW_SEED_RUNTIME_MEMORY", "1") != "0":
    memory_file = workspace / "MEMORY.md"
    if not memory_file.exists():
        memory_file.write_text(
            "\n".join(
                [
                    "# Runtime Memory",
                    "",
                    "- This agent is running as the OpenClaw custom runtime inside LiteLLM Agent Platform.",
                    "- Browser automation is available through the container Chromium installation when the browser plugin is running.",
                    "- Model inference is routed through the LAP gateway via the configured litellm provider.",
                    "",
                ],
            ),
            encoding="utf-8",
        )

models = [
    model.strip()
    for model in os.environ.get("LITELLM_MODELS", "").split(",")
    if model.strip()
]
primary = os.environ["OPENCLAW_AGENT_MODEL"].strip()
if "/" in primary:
    _, primary_model = primary.split("/", 1)
    if primary_model and primary_model not in models:
        models.insert(0, primary_model)

provider_id = os.environ["LITELLM_PROVIDER_ID"].strip() or "litellm"
provider_api = os.environ["LITELLM_PROVIDER_API"].strip() or "anthropic-messages"
provider = {
    "baseUrl": os.environ["LITELLM_BASE_URL"].rstrip("/"),
    "apiKey": os.environ.get("LITELLM_API_KEY", ""),
    "auth": "api-key",
    "api": provider_api,
    "request": {"allowPrivateNetwork": True},
    "models": [
        {
            "id": model,
            "name": model,
            "api": provider_api,
            "contextWindow": 200000,
            "maxTokens": 8192,
        }
        for model in models
    ],
}

memory_search = {
    "provider": os.environ.get("OPENCLAW_MEMORY_PROVIDER", "none").strip() or "none",
    "sources": ["memory"],
}
memory_model = os.environ.get("OPENCLAW_MEMORY_MODEL", "").strip()
if memory_model:
    memory_search["model"] = memory_model


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


config = {
    "browser": {
        "enabled": True,
        "executablePath": os.environ["OPENCLAW_BROWSER_EXECUTABLE_PATH"],
        "headless": env_bool("OPENCLAW_BROWSER_HEADLESS", True),
        "noSandbox": env_bool("OPENCLAW_BROWSER_NO_SANDBOX", True),
        "localLaunchTimeoutMs": env_int("OPENCLAW_BROWSER_LAUNCH_TIMEOUT_MS", 30000),
        "localCdpReadyTimeoutMs": env_int("OPENCLAW_BROWSER_CDP_READY_TIMEOUT_MS", 30000),
        "ssrfPolicy": {
            "dangerouslyAllowPrivateNetwork": env_bool("OPENCLAW_BROWSER_ALLOW_PRIVATE_NETWORK", True),
        },
    },
    "gateway": {
        "mode": "local",
        "bind": "loopback",
        "http": {
            "endpoints": {
                "chatCompletions": {"enabled": True},
            },
        },
    },
    "agents": {
        "defaults": {
            "model": {"primary": primary},
            "workspace": str(workspace),
            "skipBootstrap": True,
            "memorySearch": memory_search,
        },
        "list": [
            {
                "id": os.environ["OPENCLAW_AGENT_ID"],
                "default": True,
                "workspace": str(workspace),
                "memorySearch": memory_search,
                "identity": {
                    "name": "LAP OpenClaw",
                    "theme": "control-plane runtime",
                    "emoji": "OC",
                },
            },
        ],
    },
    "models": {
        "providers": {
            provider_id: provider,
        },
    },
}

(config_dir / "openclaw.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
PY

openclaw gateway run \
  --allow-unconfigured \
  --auth token \
  --token "$OPENCLAW_GATEWAY_TOKEN" \
  --port "$OPENCLAW_PORT" \
  --force &
openclaw_pid=$!

shutdown() {
  kill "$openclaw_pid" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

python3 - <<'PY'
import os
import time
import urllib.request

url = f"http://127.0.0.1:{os.environ.get('OPENCLAW_PORT', '18789')}/health"
deadline = time.time() + 60
last_error = None
while time.time() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            if response.status == 200:
                raise SystemExit(0)
    except Exception as exc:
        last_error = exc
        time.sleep(1)
raise SystemExit(f"OpenClaw gateway did not become healthy: {last_error}")
PY

if [ "$OPENCLAW_MEMORY_INDEX_ON_BOOT" != "0" ]; then
  timeout "$OPENCLAW_BOOT_TASK_TIMEOUT_SECONDS" openclaw memory index --agent "$OPENCLAW_AGENT_ID" --force >/tmp/openclaw-memory-index.log 2>&1 || true
  timeout "$OPENCLAW_BOOT_TASK_TIMEOUT_SECONDS" openclaw memory status --agent "$OPENCLAW_AGENT_ID" --fix >/tmp/openclaw-memory-status.log 2>&1 || true
fi

if [ "$OPENCLAW_BROWSER_ON_BOOT" != "0" ]; then
  timeout "$OPENCLAW_BOOT_TASK_TIMEOUT_SECONDS" openclaw browser start >/tmp/openclaw-browser-start.log 2>&1 || true
  timeout "$OPENCLAW_BOOT_TASK_TIMEOUT_SECONDS" openclaw browser doctor --deep >/tmp/openclaw-browser-doctor.log 2>&1 || true
fi

exec uvicorn src.server:app --host 0.0.0.0 --port "${PORT:-8080}"
