#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-7860}"
export SIDECAR_HOST="${SIDECAR_HOST:-127.0.0.1}"
export SIDECAR_PORT="${SIDECAR_PORT:-7070}"
export SIDECAR_URL="${SIDECAR_URL:-http://127.0.0.1:${SIDECAR_PORT}}"
export MODEL_CACHE_DIR="${MODEL_CACHE_DIR:-/tmp/adra-models}"
export WHISPER_MODEL_SIZE="${WHISPER_MODEL_SIZE:-tiny}"

mkdir -p "$MODEL_CACHE_DIR"

echo "[ADRA] Starting Python sidecar on ${SIDECAR_HOST}:${SIDECAR_PORT}"
(
  cd /app/python/sidecar
  /opt/adra-sidecar/bin/uvicorn main:app \
    --host "$SIDECAR_HOST" \
    --port "$SIDECAR_PORT" \
    --workers 1
) &
SIDECAR_PID=$!

echo "[ADRA] Waiting for Python sidecar health"
SIDECAR_READY=0
for _ in $(seq 1 45); do
  if /opt/adra-sidecar/bin/python -c "import urllib.request; urllib.request.urlopen('${SIDECAR_URL}/health', timeout=1).read()" >/dev/null 2>&1; then
    SIDECAR_READY=1
    break
  fi
  sleep 1
done

if [ "$SIDECAR_READY" = "1" ]; then
  echo "[ADRA] Python sidecar is healthy"
else
  echo "[ADRA] Python sidecar did not become healthy before Node startup; continuing with local fallbacks"
fi

cleanup() {
  kill "$SIDECAR_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[ADRA] Starting Node/React server on port ${PORT}"
node server/index.js
