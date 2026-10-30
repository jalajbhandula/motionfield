#!/bin/sh
# start.sh — one-command MotionField: Docker Postgres, migrate, seed,
# build when stale, start, print the URL.
#
#   sh start.sh [--port N] [--provider mock|comfy]
#
# With no ComfyUI on :8188 the app still works — the mock provider renders
# synthetic outputs so every page stays clickable. Set GENERATION_PROVIDER
# / COMFY_BASE_URL yourself to point at your own ComfyUI.
set -eu

cd "$(dirname "$0")"

PORT="${PORT:-3000}"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --provider) GENERATION_PROVIDER="$2"; export GENERATION_PROVIDER; shift 2 ;;
    *) echo "usage: sh start.sh [--port N] [--provider mock|comfy]" >&2; exit 2 ;;
  esac
done

# Match Next's production env-file precedence without sourcing shell code.
node_with_env() {
  for file in .env.production.local .env.local .env.production .env; do
    [ ! -f "$file" ] || set -- "--env-file=$file" "$@"
  done
  node "$@"
}

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required; install the version specified in package.json and retry." >&2
  exit 1
fi

# Install from the repository's lockfile, not an absent npm lockfile.
if [ ! -x node_modules/.bin/next ] || [ ! -f node_modules/.modules.yaml ] \
  || [ package.json -nt node_modules/.modules.yaml ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  echo "· installing dependencies (pnpm install --frozen-lockfile)…"
  pnpm install --frozen-lockfile
fi

GENERATION_PROVIDER="$(node_with_env -p 'process.env.GENERATION_PROVIDER || "mock"')"
case "$GENERATION_PROVIDER" in
  mock|comfy) export GENERATION_PROVIDER ;;
  *) echo "Unknown GENERATION_PROVIDER: $GENERATION_PROVIDER (use mock or comfy)" >&2; exit 2 ;;
esac

# One database: Postgres in Docker. An already-set DATABASE_URL is used as-is.
DB_URL="$(node_with_env -p 'process.env.DATABASE_URL || ""')"
if [ -n "$DB_URL" ]; then
  export DATABASE_URL="$DB_URL"
  echo "· database: Postgres from DATABASE_URL"
elif [ -f docker-compose.yml ] && command -v docker >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is installed but not running. Start Docker, then run this again." >&2
    exit 1
  fi
  echo "· database: starting Postgres (docker compose)…"
  docker compose up -d --wait db
  export DATABASE_URL="postgres://motionfield:motionfield@127.0.0.1:5432/motionfield"
  echo "· database: Postgres on 127.0.0.1:5432"
else
  echo "Postgres is required. Install Docker, then: docker compose up -d db" >&2
  exit 1
fi

echo "· migrating database…"
node_with_env --experimental-strip-types scripts/migrate.ts
echo "· seeding…"
node_with_env --experimental-strip-types scripts/seed.ts

# Build when the configured output directory is missing or sources are newer.
BUILD_DIR="$(node_with_env -p 'process.env.MOTIONFIELD_DIST_DIR || ".next"')"
STALE=0
if [ ! -f "$BUILD_DIR/BUILD_ID" ]; then
  STALE=1
else
  NEWER=$(find src workflows packages scripts db -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.json' -o -name '*.sql' \) -newer "$BUILD_DIR/BUILD_ID" 2>/dev/null | head -1)
  [ -n "$NEWER" ] && STALE=1
  for file in next.config.ts package.json pnpm-lock.yaml .env .env.local .env.production .env.production.local; do
    [ ! -f "$file" ] || [ ! "$file" -nt "$BUILD_DIR/BUILD_ID" ] || STALE=1
  done
fi
if [ "$STALE" = 1 ]; then
  echo "· building (first run takes a couple of minutes)…"
  pnpm run build
fi

echo "· generation provider: $GENERATION_PROVIDER"
if [ "$GENERATION_PROVIDER" = "mock" ]; then
  echo "  mock outputs are synthetic; configure ComfyUI and the proxy on :8189 for real generation."
fi

echo ""
echo "  MotionField → http://localhost:${PORT}"
echo ""
exec pnpm exec next start -p "$PORT"
