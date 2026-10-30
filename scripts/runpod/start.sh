#!/bin/bash
# MotionField RunPod start — launches ComfyUI and the API proxy bound to
# loopback only. Reach them through the SSH tunnel (see docs/CLOUD.md):
#   ssh -N -L 18189:127.0.0.1:8189 root@<pod-ip> -p <port>
# The pod's public HTTP proxy is never used.
set -euo pipefail

COMFY_HOME="${COMFY_HOME:-/workspace/ComfyUI}"
VENV="${VENV:-$COMFY_HOME/.venv}"
STATE_DIR="${STATE_DIR:-/workspace/.motionfield/comfy-proxy}"

# proxy first — it is the app's only surface; ComfyUI itself stays on its own
# loopback port. `uv tool install` lands the binary in ~/.local/bin, which
# root shells usually keep off PATH — fall back to it (PROXY_BIN overrides).
PROXY_BIN="${PROXY_BIN:-$(command -v comfy-api-proxy || echo "$HOME/.local/bin/comfy-api-proxy")}"
if [ ! -x "$PROXY_BIN" ]; then
  echo "start.sh: comfy-api-proxy not found or not executable ($PROXY_BIN) — run scripts/runpod/setup.sh first, or set PROXY_BIN" >&2
  exit 1
fi

# when COMFY_API_KEY is set the proxy requires the token on every request —
# the API-key gate. It travels on argv (visible in `ps` on this single-tenant
# pod) and is never echoed by this script.
proxy_args=(run --host 127.0.0.1 --port 8189
  --comfyui http://127.0.0.1:8188 --state-dir "$STATE_DIR")
if [ -n "${COMFY_API_KEY:-}" ]; then
  proxy_args+=(--token "$COMFY_API_KEY")
fi
mkdir -p "$STATE_DIR"
"$PROXY_BIN" "${proxy_args[@]}" &
proxy_pid=$!
sleep 2
kill -0 "$proxy_pid" 2>/dev/null || {
  echo "start.sh: comfy-api-proxy exited on launch — check the error above" >&2
  exit 1
}
echo "comfy-api-proxy pid $proxy_pid → 127.0.0.1:8189"

# An LLM on the same GPU (e.g. Ollama for the explainer/dub writers) needs
# VRAM that ComfyUI's model cache would otherwise take: with ~58 GB cached a
# 27B Q4 model got only 11 of 19 GB on the GPU and ran at 0.16 tok/s, so every
# LLM step timed out. Set COMFY_RESERVE_VRAM (GB, e.g. 22) to leave it room.
comfy_args=(main.py --listen 127.0.0.1 --port 8188)
if [ -n "${COMFY_RESERVE_VRAM:-}" ]; then
  comfy_args+=(--reserve-vram "$COMFY_RESERVE_VRAM")
fi
cd "$COMFY_HOME"
exec "$VENV/bin/python" "${comfy_args[@]}"
