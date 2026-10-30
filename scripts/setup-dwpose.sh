#!/usr/bin/env bash
# Stage the DWPose ONNX weights (Apache-2.0, huggingface.co/yzd-v/DWPose)
# that motionfield_nodes OF_DWPose and the MuseTalk pack both load:
#
#   <comfyui>/models/motionfield/dwpose/{yolox_l.onnx,dw-ll_ucoco_384.onnx}
#
#   ./scripts/setup-dwpose.sh [comfyui-dir]     # default: ~/comfy/ComfyUI
#
# Source order per file: keep the staged copy when its sha256 matches the
# pinned upstream blob; otherwise hardlink from an existing local copy
# (the MuseTalk dwpose dir, or the comfyui_controlnet_aux ckpts copy);
# otherwise download with curl and verify the sha256 before moving it in.
# Idempotent — safe to re-run.
set -euo pipefail

COMFY_DIR="${1:-${COMFYUI_DIR:-$HOME/comfy/ComfyUI}}"
MODELS_DIR="$COMFY_DIR/models"
DEST="$MODELS_DIR/motionfield/dwpose"
MUSE_DWPOSE="$MODELS_DIR/diffusers/TMElyralab/MuseTalk/dwpose"
AUX_CKPTS="$COMFY_DIR/custom_nodes/comfyui_controlnet_aux/ckpts/yzd-v/DWPose"
HF_BASE="https://huggingface.co/yzd-v/DWPose/resolve/main"

# pinned sha256 of the yzd-v/DWPose blobs
sha256_for() {
  case "$1" in
    yolox_l.onnx) echo "7860ae79de6c89a3c1eb72ae9a2756c0ccfbe04b7791bb5880afabd97855a411" ;;
    dw-ll_ucoco_384.onnx) echo "724f4ff2439ed61afb86fb8a1951ec39c6220682803b4a8bd4f598cd913b1843" ;;
    *) return 1 ;;
  esac
}

sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

[ -d "$MODELS_DIR" ] || { echo "no models dir under $COMFY_DIR — pass your ComfyUI dir"; exit 1; }
mkdir -p "$DEST"

for f in yolox_l.onnx dw-ll_ucoco_384.onnx; do
  want="$(sha256_for "$f")"
  if [ -f "$DEST/$f" ] && [ "$(sha_of "$DEST/$f")" = "$want" ]; then
    echo "ok       $f already staged"
    continue
  fi
  linked=""
  for src in "$MUSE_DWPOSE/$f" "$AUX_CKPTS/$f"; do
    if [ -f "$src" ] && [ "$(sha_of "$src")" = "$want" ]; then
      rm -f "$DEST/$f"
      ln "$src" "$DEST/$f" 2>/dev/null || cp "$src" "$DEST/$f"
      echo "linked   $f <- $src"
      linked=1
      break
    fi
  done
  [ -n "$linked" ] && continue
  echo "download $f from yzd-v/DWPose"
  tmp="$DEST/$f.part"
  rm -f "$tmp"
  curl -fsSL --retry 3 -o "$tmp" "$HF_BASE/$f"
  if [ "$(sha_of "$tmp")" != "$want" ]; then
    rm -f "$tmp"
    echo "sha256 mismatch on downloaded $f — refusing to stage" >&2
    exit 1
  fi
  mv "$tmp" "$DEST/$f"
  echo "staged   $f"
done

echo "done. OF_DWPose weights live under $DEST"
