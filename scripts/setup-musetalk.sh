#!/usr/bin/env bash
# Reproduce MotionField's patched ComfyUI-MuseTalk pack.
#
#   ./scripts/setup-musetalk.sh [--reset] [comfyui-dir]   # default: ~/comfy/ComfyUI
#
# What it does (idempotent — safe to re-run):
#   1. clones chaojie/ComfyUI-MuseTalk (MIT) into <comfyui>/custom_nodes if absent
#   2. checks out the pinned upstream commit
#   3. applies scripts/patches/comfyui-musetalk-mps.patch (skips if already applied)
#      — with --reset it wipes the pack back to the pinned commit first, which
#      is the upgrade path when an older MotionField patch is already applied and
#      the new one "does not apply cleanly"
#   4. drops the upstream face segmenter module (musetalk/utils/face_parsing)
#      — nothing imports it once the patch lands; the mouth blend region comes
#      from the MotionField OF_MouthMask node (DWPose landmarks), so the
#      segmenter's weights aren't needed either
#   5. pip-installs the pack's runtime deps into <comfyui>/.venv
#   6. stages the Apache-2.0 DWPose ONNX weights via setup-dwpose.sh into
#      models/motionfield/dwpose/, then links them into the pack's
#      models/diffusers/TMElyralab/MuseTalk/dwpose/ dir
#
# The upstream requirements.txt (mmlab mmcv/mmdet/mmpose) is intentionally NOT
# installed — it has no Apple-Silicon/py3.14 wheels, and our patch replaces the
# whole landmark/bbox path with the vendored Apache-2.0 DWPose ONNX pipeline
# (musetalk/utils/dwpose_onnx/), which also replaces the research-licensed S3FD
# face detector. Weights still needed under models/diffusers/TMElyralab/
# MuseTalk/ — see MODELS.md for the bundle layout and licenses.
set -euo pipefail

RESET=0
if [ "${1:-}" = "--reset" ]; then RESET=1; shift; fi

COMFY_DIR="${1:-${COMFYUI_DIR:-$HOME/comfy/ComfyUI}}"
PACK_DIR="$COMFY_DIR/custom_nodes/ComfyUI-MuseTalk"
CKPT_DIR="$COMFY_DIR/models/diffusers/TMElyralab/MuseTalk/dwpose"
UPSTREAM="https://github.com/chaojie/ComfyUI-MuseTalk"
COMMIT="84f4b6dcbb0d87e87687f324092056646582457d"
PATCH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/patches/comfyui-musetalk-mps.patch"
DWPOSE_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup-dwpose.sh"
PIP="$COMFY_DIR/.venv/bin/pip"

[ -d "$COMFY_DIR/custom_nodes" ] || { echo "no custom_nodes under $COMFY_DIR — pass your ComfyUI dir"; exit 1; }
[ -x "$PIP" ] || { echo "no venv pip at $PIP — create ComfyUI's .venv first"; exit 1; }

if [ ! -d "$PACK_DIR/.git" ]; then
  git clone "$UPSTREAM" "$PACK_DIR"
fi
cd "$PACK_DIR"
git fetch -q "$UPSTREAM" "$COMMIT" 2>/dev/null || true

# upgrade path: a pack carrying an older MotionField patch can't take the new
# one over the top — wipe the tracked + untracked tree back to HEAD first,
# then the pinned checkout + apply go through. --reset is explicit because
# it discards local edits.
if [ "$RESET" = "1" ]; then
  git checkout -- .
  git clean -fdxq
  echo "pack reset to HEAD"
fi
git checkout -q "$COMMIT"

if git apply --check --reverse "$PATCH" 2>/dev/null; then
  echo "musetalk patch already applied — nothing to do"
elif git apply --check "$PATCH" 2>/dev/null; then
  git apply "$PATCH"
  echo "musetalk patch applied"
else
  echo "patch does not apply cleanly — is $PACK_DIR dirty?" >&2
  echo "  (an older MotionField patch on the pack needs: $0 --reset)" >&2
  git status --short >&2
  exit 1
fi

# nothing imports the upstream face segmenter after the patch — remove the
# module so no stray import revives it (idempotent; rm -rf is fine if it's
# already gone)
rm -rf "$PACK_DIR/musetalk/utils/face_parsing"

"$PIP" install --quiet \
  diffusers omegaconf ffmpeg-python pydub soundfile imageio-ffmpeg regex scipy \
  onnxruntime huggingface_hub opencv-python

# DWPose ONNX weights (Apache-2.0, HF yzd-v/DWPose): setup-dwpose.sh stages
# the canonical copy under models/motionfield/dwpose/ — link it into the
# pack's own dwpose dir for its vendored pipeline.
"$DWPOSE_SH" "$COMFY_DIR"
mkdir -p "$CKPT_DIR"
for f in yolox_l.onnx dw-ll_ucoco_384.onnx; do
  if [ ! -f "$CKPT_DIR/$f" ]; then
    ln "$COMFY_DIR/models/motionfield/dwpose/$f" "$CKPT_DIR/$f" 2>/dev/null || \
      cp "$COMFY_DIR/models/motionfield/dwpose/$f" "$CKPT_DIR/$f"
    echo "staged $f from models/motionfield/dwpose"
  fi
done

echo "done. MuseTalk weights go under $COMFY_DIR/models/diffusers/TMElyralab/MuseTalk/ (see MODELS.md)."
