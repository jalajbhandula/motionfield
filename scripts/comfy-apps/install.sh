#!/bin/sh
# install.sh — link the MotionField node pack into ComfyUI's custom_nodes and
# copy the generated Apps into user/default/workflows/MotionField/.
#
#   sh scripts/comfy-apps/install.sh [--comfy DIR] [--remove]
#
# --comfy DIR  ComfyUI checkout (default: $COMFYUI_DIR or ~/comfy/ComfyUI)
# --remove     unlink the pack and delete the installed apps
set -eu

COMFY="${COMFYUI_DIR:-$HOME/comfy/ComfyUI}"
REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --comfy) COMFY="$2"; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    *) echo "usage: $0 [--comfy DIR] [--remove]" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PACK="$ROOT/comfy-nodes/motionfield_nodes"
APPS="$ROOT/comfy-nodes/motionfield_nodes/example_workflows"
CN="$COMFY/custom_nodes/motionfield_nodes"
WF_DIR="$COMFY/user/default/workflows/MotionField"

if [ "$REMOVE" = 1 ]; then
  [ -L "$CN" ] && rm "$CN" && echo "unlinked $CN"
  [ -d "$WF_DIR" ] && rm -rf "$WF_DIR" && echo "removed $WF_DIR"
  exit 0
fi

[ -d "$COMFY" ] || { echo "ComfyUI not found at $COMFY — pass --comfy DIR" >&2; exit 1; }
[ -d "$COMFY/custom_nodes" ] || { echo "$COMFY/custom_nodes missing" >&2; exit 1; }

if [ -e "$CN" ] && [ ! -L "$CN" ]; then
  echo "$CN exists and is not a symlink — leaving it alone" >&2
else
  ln -sfn "$PACK" "$CN"
  echo "linked $CN -> $PACK"
fi

mkdir -p "$WF_DIR"
count=0
for f in "$APPS"/*.app.json; do
  [ -e "$f" ] || { echo "no .app.json files in $APPS — run: npx tsx scripts/comfy-apps/build.ts" >&2; exit 1; }
  cp "$f" "$WF_DIR/"
  count=$((count + 1))
done
echo "installed $count apps into $WF_DIR"
echo "restart ComfyUI (or refresh the workflows list) to pick up the node pack."
