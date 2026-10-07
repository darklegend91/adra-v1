#!/usr/bin/env bash
# ADRA ML Sidecar — setup and launch using the project venv
# Usage: bash python/sidecar/start.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV="$SCRIPT_DIR/venv"
PYTHON="$VENV/bin/python"
PIP="$VENV/bin/pip"

# ── Create venv if missing ────────────────────────────────────────────────────
if [ ! -f "$PYTHON" ]; then
  echo "[ADRA] Creating Python venv..."
  python3 -m venv "$VENV"
fi

echo "[ADRA] Using $($PYTHON --version)"

# ── Install dependencies into venv ───────────────────────────────────────────
echo "[ADRA] Installing Python dependencies into venv..."
$PIP install --upgrade pip --quiet
$PIP install -r requirements.txt

# ── PaddleOCR (optional — no Python 3.13/3.14 wheel yet) ─────────────────────
echo "[ADRA] Trying PaddleOCR install (skipped if no compatible wheel)..."
$PIP install paddlepaddle paddleocr --quiet 2>/dev/null \
  && echo "[ADRA] PaddleOCR installed — /ocr endpoint active." \
  || echo "[ADRA] PaddleOCR unavailable for this Python version — Tesseract.js fallback will be used."

# ── NER model (bc5cdr preferred; en_core_web_sm fallback for Python 3.13+) ───
echo "[ADRA] Installing NER model..."
$PIP install \
  "https://s3-us-west-2.amazonaws.com/ai2-s2-scispacy/releases/v0.5.4/en_ner_bc5cdr_md-0.5.4.tar.gz" \
  --no-build-isolation --quiet 2>/dev/null \
  || $PIP install \
     "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl" \
     --quiet \
  || echo "[ADRA] NER model install skipped — pattern-only extraction will be used"

# ── Launch with venv uvicorn ─────────────────────────────────────────────────
echo "[ADRA] Starting sidecar on port ${SIDECAR_PORT:-7070}..."
exec "$VENV/bin/uvicorn" main:app \
  --host "${SIDECAR_HOST:-127.0.0.1}" \
  --port "${SIDECAR_PORT:-7070}" \
  --workers 1
