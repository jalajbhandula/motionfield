#!/bin/sh
# swap-media.sh — refresh a README media slot from verified evidence.
#
#   sh scripts/docs/swap-media.sh <slot> <evidence-file>
#
# Slots: image | vfx | director | reshoot | person-swap
# The slots marked TODO in README.md wait on the owning lane's verified
# output — drop the file in tests/artifacts/ first, then call this.
# Caps: images ≤150 KB, videos ≤400 KB (contest README budget).
set -eu
[ $# -eq 2 ] || { echo "usage: sh scripts/docs/swap-media.sh <slot> <file>" >&2; exit 2; }
slot="$1"; src="$2"
[ -f "$src" ] || { echo "no such file: $src" >&2; exit 1; }

case "$src" in
  *.mp4|*.gif|*.webm) kind=video; cap=409600 ;;
  *.png|*.jpg|*.jpeg)  kind=image; cap=153600 ;;
  *) echo "unknown media type: $src" >&2; exit 1 ;;
esac
size=$(wc -c < "$src" | tr -d ' ')
[ "$size" -le "$cap" ] || { echo "$src is $size B — over the $cap B cap for $kind" >&2; exit 1; }

ext="${src##*.}"
case "$slot" in
  image|director|reshoot|person-swap|vfx) ;;
  *) echo "unknown slot: $slot (image|vfx|director|reshoot|person-swap)" >&2; exit 1 ;;
esac
mkdir -p docs/media
cp "$src" "docs/media/${slot}.$ext"
echo "docs/media/${slot}.${ext}  ←  $src ($size B) — update the README slot line"
