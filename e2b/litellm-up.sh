#!/usr/bin/env bash
# litellm-up — start the LiteLLM proxy and only return once it's actually serving.
#
# On success prints ONE JSON line: {"port":N,"master_key":"sk-1234","url":"..."}
# On failure exits non-zero after tailing the proxy log + flagging OOM, so callers
# never hang on a silent failure.
#
# Usage:  litellm-up [PORT]        # PORT optional; a free one is chosen if omitted
set -uo pipefail

# 1. Postgres (idempotent). start-db exits non-zero and prints the pg log on
#    failure — abort fast instead of starting litellm against a dead DB and
#    burning the full 150s readiness wait on a misleading sqlalchemy error.
if ! /usr/local/bin/start-db; then
  echo "[litellm-up] postgres did not start (see start-db output above) — aborting." >&2
  exit 1
fi

# 2. Dev env (only fills gaps — image ENV already sets these).
export DATABASE_URL="${DATABASE_URL:-postgresql://litellm:litellm@localhost:5432/litellm}"
export LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-sk-1234}"
export LITELLM_SALT_KEY="${LITELLM_SALT_KEY:-sk-litellm-salt-dev-unsafe}"
export STORE_MODEL_IN_DB="${STORE_MODEL_IN_DB:-True}"
# Silence the weave -> opentelemetry import noise on boot.
export DISABLE_PROMETHEUS="${DISABLE_PROMETHEUS:-true}"

# 3. Port — caller-supplied, else an OS-assigned free one. There's a tiny TOCTOU
#    window between picking the port and litellm binding it; acceptable in a
#    single-tenant sandbox, and if the race is ever lost the proxy exits
#    immediately and fail() surfaces the "address already in use" log line.
PORT="${1:-$(python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()')}"

LOGDIR=/tmp/llmlogs; mkdir -p "$LOGDIR"
LOG="$LOGDIR/proxy.${PORT}.log"
# Config lives in the image at /home/user (persists) — NOT /tmp, which is a fresh
# tmpfs on sandbox boot and wipes anything baked there. Seed a default if absent.
CONFIG="${LITELLM_CONFIG:-/home/user/litellm_config.yaml}"
if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" <<'YAML'
model_list: []
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
litellm_settings:
  drop_params: true
YAML
fi
cd "${LITELLM_DIR:-/home/user/litellm}"

# Regenerate the prisma client for the RUNTIME user. The client baked at build
# time is generated as root (build-time site-packages is root-owned), and a
# root-generated client fails at runtime with
#   prisma.engine.errors.NotConnectedError: Not connected to the query engine
# when the proxy runs as `user` — the proxy then never reaches /health/readiness.
# At runtime e2b makes /usr/local world-writable, so this regenerate (~850ms,
# idempotent) succeeds and is the difference between the proxy starting or not.
python -m prisma generate --schema schema.prisma >/dev/null 2>&1 \
  || echo "[litellm-up] warning: prisma generate failed — proxy may not reach readiness" >&2

# --use_prisma_db_push: `prisma db push` (≈600 ms) instead of `migrate deploy`
# across all 124 migrations (~20 min). Correct for an ephemeral dev DB — we want
# the schema, not migration history.
echo "[litellm-up] starting proxy on :$PORT (db push, log: $LOG)" >&2
nohup python -m litellm.proxy.proxy_cli \
  --config "$CONFIG" --port "$PORT" --use_prisma_db_push > "$LOG" 2>&1 &
PID=$!
echo "$PORT" > "$LOGDIR/current_port"   # record now so litellm-status can find us mid-boot

fail() {
  echo "[litellm-up] $1" >&2
  echo "----- last 40 lines of $LOG -----" >&2
  tail -40 "$LOG" >&2 2>/dev/null || true
  if dmesg 2>/dev/null | grep -iE "oom|killed process" | tail -3 | grep -q .; then
    echo "----- OOM detected (dmesg) — the proxy was killed for memory. Use the litellm-ready/4gb template, not base. -----" >&2
    dmesg 2>/dev/null | grep -iE "oom|killed process" | tail -3 >&2
  fi
  exit 1
}

# Wait up to ~80s — kept UNDER the 120s sandbox_execute cap so this call always
# returns cleanly instead of being killed mid-wait. A dead process is a hard
# failure; still-booting is NOT — return status:"starting" and let the caller
# poll `litellm-status` until ready (that's the status->up pattern the skill teaches).
for _ in $(seq 1 40); do
  kill -0 "$PID" 2>/dev/null || fail "proxy process exited before becoming ready."
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health/readiness" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    printf '{"port":%s,"master_key":"%s","url":"http://127.0.0.1:%s","status":"ready"}\n' "$PORT" "$LITELLM_MASTER_KEY" "$PORT"
    exit 0
  fi
  sleep 2
done
echo "[litellm-up] proxy still booting after ~80s but alive — poll: litellm-status" >&2
printf '{"port":%s,"master_key":"%s","url":"http://127.0.0.1:%s","status":"starting"}\n' "$PORT" "$LITELLM_MASTER_KEY" "$PORT"
exit 0
