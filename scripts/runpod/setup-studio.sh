#!/bin/bash
# Prepare the implemented contest graphics workflows; audio runs on the pod now.
# --dry-run prints the weight plan without installing or downloading anything.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMFY_HOME="${COMFY_HOME:-/workspace/ComfyUI}"
WORKFLOWS="wan22a14b-t2v.json,wan22a14b-i2v.json,wan-animate-character-swap.json,reshoot-uni3c.json,qwenedit2511-edit.json,qwenedit2511-angles.json,director-wan.json,director-wan-txt.json,stage-render.json"
DRY=0
DEMO=0
MIN_GPU_MB=75000
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --demo)
      DEMO=1
      WORKFLOWS="director-wan.json,director-wan-txt.json,reshoot-video.json,klein-txt2img.json,klein-edit.json,video-finish.json"
      MIN_GPU_MB=45000
      ;;
    *) echo "usage: setup-studio.sh [--demo] [--dry-run]" >&2; exit 2 ;;
  esac
done
if [ "$DRY" = 1 ]; then
  bash "$HERE/setup.sh" --dry-run --tier A --workflows "$WORKFLOWS"
  if [ "$DEMO" = 1 ]; then
    echo "Graphics weights come from HF (manifest) + RealESRGAN_x4plus.pth from the official GitHub release; nothing is copied from the Mac."
    echo "Software: pinned VHS + MotionField. Kokoro/MuseTalk install with a full --tier A run; audio runs on the pod now."
  else
    echo "Additional graphics files: the manifest fetches the dwpose/MuseTalk/RealESRGAN/Kokoro weights itself; the files still not manifest-covered are listed in scripts/runpod/studio-files.txt."
    echo "Kokoro + MuseTalk: a full --tier A run installs both packs via setup.sh (kokoro_v1.onnx is sha-verified, voices_v1.bin is generated on the pod)."
    echo "Software: pinned VHS + MotionField + Kokoro + patched MuseTalk; no LTX-2, FlashVSR or LongCat downloads."
  fi
  exit 0
fi
command -v ffmpeg >/dev/null || { echo "Install ffmpeg before setup." >&2; exit 5; }
command -v runpodctl >/dev/null || { echo "Install/configure the official RunPod CLI before setup; the spending guard needs it." >&2; exit 5; }
# Refuse a mismatched pod before any heavyweight download.
memory="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)"
[ "${memory:-0}" -ge "$MIN_GPU_MB" ] || { echo "This profile needs at least $MIN_GPU_MB MiB GPU memory." >&2; exit 5; }
bash "$HERE/setup.sh" --tier A --workflows "$WORKFLOWS"
MODELS_DIR="${MODELS_DIR:-$COMFY_HOME/models}"
# video-finish.json pins the .pth; Comfy-Org only repacks it as .safetensors,
# so fetch the official release and verify it (same sha as the Mac copy).
ESRGAN="$MODELS_DIR/upscale_models/RealESRGAN_x4plus.pth"
ESRGAN_SHA=4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1
if [ "$(sha256sum "$ESRGAN" 2>/dev/null | cut -d' ' -f1)" != "$ESRGAN_SHA" ]; then
  mkdir -p "$(dirname "$ESRGAN")"
  curl -fL -o "$ESRGAN" https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
  [ "$(sha256sum "$ESRGAN" | cut -d' ' -f1)" = "$ESRGAN_SHA" ] || { mv -f "$ESRGAN" "$ESRGAN.bad"; echo "RealESRGAN_x4plus.pth sha256 mismatch" >&2; exit 4; }
fi
# The Mac .env maps flux-2-klein-4b.safetensors -> flux-2-klein-4b-bf16.safetensors
# (its local dequant). Alias the official file so that map works on the pod too.
KLEIN="$MODELS_DIR/diffusion_models/flux-2-klein-4b.safetensors"
[ -f "$KLEIN" ] && ln -sfn flux-2-klein-4b.safetensors "$MODELS_DIR/diffusion_models/flux-2-klein-4b-bf16.safetensors"
if [ "$DEMO" = 1 ]; then
  echo "Demo software + weights installed. Next: start.sh; audio runs on the pod — a full --tier A run fetches the Kokoro/MuseTalk weights and installs both packs."
  echo "Before generation: validate every selected graph against /object_info. CUDA quality is still unverified."
  exit 0
fi
KOKORO="$COMFY_HOME/custom_nodes/comfyui-kokoro"
if [ ! -d "$KOKORO/.git" ]; then git clone https://github.com/stavsap/comfyui-kokoro.git "$KOKORO"; fi
git -C "$KOKORO" fetch -q origin cfb59b5605b351e196182c836f0b48c1a784e52f
git -C "$KOKORO" checkout -q cfb59b5605b351e196182c836f0b48c1a784e52f
"$COMFY_HOME/.venv/bin/pip" install -r "$KOKORO/requirements.txt"
bash "$ROOT/scripts/setup-musetalk.sh" "$COMFY_HOME"
echo "Software installed. Copy the studio-files.txt entries the manifest doesn't cover, then start.sh."
echo "Before any generation: fetch /object_info and lint every selected graph. GPU quality remains unverified until real output checks pass."
