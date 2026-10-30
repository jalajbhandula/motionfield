#!/bin/bash
# Sync this repo into the pod's existing clone over SSH — the GitHub repo is
# private, so the pod never pulls/clones from it. rsync only, over the
# dedicated key.
#
#   POD_HOST=<host> POD_PORT=<port> scripts/runpod/sync-to-pod.sh [--dry-run]
#
# POD_REPO overrides the clone path on the pod (default /workspace/motionfield).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

POD_HOST="${POD_HOST:?POD_HOST env required (runpod ssh host)}"
POD_PORT="${POD_PORT:?POD_PORT env required (runpod ssh port)}"
POD_REPO="${POD_REPO:-/workspace/motionfield}"
KEY="${SSH_KEY:-$HOME/.ssh/runpod_motionfield}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

SSH=(ssh -i "$KEY" -p "$POD_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
RSYNC=(rsync -az --delete-delay --partial -e "ssh -i $KEY -p $POD_PORT -o StrictHostKeyChecking=accept-new")
[ "$DRY" = 1 ] && RSYNC+=(--dry-run)

# Never sync secrets, local data, build output, or user media.
EXCLUDES=(.env .env.* .data/ node_modules/ .next .next\* public/files/ .git/
  hf-*.png "*.local" "of-reports/" ".DS_Store")
RSYNC+=( "${EXCLUDES[@]/#/--exclude=}" )

echo "sync: $ROOT/ -> root@$POD_HOST:$POD_PORT:$POD_REPO/"
"${SSH[@]}" "root@$POD_HOST" "mkdir -p '$POD_REPO'"
"${RSYNC[@]}" "$ROOT/" "root@$POD_HOST:$POD_REPO/"
echo "sync: done ($POD_REPO)"
