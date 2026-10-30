#!/usr/bin/env bash
# Turn a real generated clip into a small looping preset poster (animated webp).
#   scripts/clip-to-webp.sh <in.mp4> <out.webp> [ffmpeg crop/scale filter]
# Needs ffmpeg + img2webp (brew install webp). Posters land in
# public/examples/<catalog>/<id>.webp, which posterFor() picks up.
set -euo pipefail
in="$1"; out="$2"; vf="${3:-scale=320:-2:flags=lanczos}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
ffmpeg -v error -i "$in" -vf "fps=10,$vf" "$tmp/f%03d.png"
img2webp -loop 0 -lossy -q 62 -m 6 -d 100 "$tmp"/f*.png -o "$out" >/dev/null
ls -la "$out"
