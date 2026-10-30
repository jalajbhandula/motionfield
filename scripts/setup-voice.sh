#!/usr/bin/env bash
# Voice-studio runtime deps for the local ComfyUI venv.
#
#   ./scripts/setup-voice.sh [comfyui-dir]     # default: ~/comfy/ComfyUI
#
# What it does (idempotent — safe to re-run):
#   1. pip-installs resemble-perth into <comfyui>/.venv — the inaudible audio
#      watermark library the ComfyUI-Chatterbox pack imports when
#      `use_watermark: true` is set on ChatterboxTTS (see
#      workflows/chatterbox-voice-clone.json). Without it the pack writes
#      UN-watermarked clone output (its import is defensive).
#   2. verifies the install by importing perth and building a watermarker.
#
# License: resemble-perth is MIT (Resemble AI) —
#   https://github.com/resemble-ai/Perth (LICENSE), pyproject `license="MIT"`,
#   PyPI https://pypi.org/project/resemble-perth/ — verified 2026-10-23.
set -euo pipefail

COMFY_DIR="${1:-${COMFYUI_DIR:-$HOME/comfy/ComfyUI}}"
PIP="$COMFY_DIR/.venv/bin/pip"
PY="$COMFY_DIR/.venv/bin/python"

[ -x "$PIP" ] || { echo "no venv pip at $PIP — create ComfyUI's .venv first"; exit 1; }

if "$PIP" show resemble-perth >/dev/null 2>&1; then
  echo "resemble-perth already installed: $("$PIP" show resemble-perth | awk '/^Version:/{print $2}')"
else
  "$PIP" install resemble-perth
fi

"$PY" - <<'EOF'
import perth
w = perth.PerthImplicitWatermarker()
print(f"perth {getattr(perth, '__version__', '?')} — watermarker OK")
EOF

echo "done. ChatterboxTTS use_watermark:true now writes Perth-watermarked clone output."
