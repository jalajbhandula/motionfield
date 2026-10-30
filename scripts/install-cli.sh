#!/bin/sh
# Install the motionfield CLI and MCP server globally via npm link.
#   ./scripts/install-cli.sh            # into your npm global prefix
#   PREFIX=/tmp/of-cli ./scripts/install-cli.sh   # into $PREFIX/bin (testing)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${PREFIX:-$(npm prefix -g 2>/dev/null || echo /usr/local)}"

mkdir -p "$PREFIX/lib" "$PREFIX/bin"
# run inside the package dir with the prefix via env — `--prefix P` makes npm
# treat P as the local project too (stray node_modules/.bin/.package-lock.json
# in $PREFIX, or an ENOENT on $PREFIX/package.json when no arg is given)
(cd "$ROOT/packages/cli" && npm_config_prefix="$PREFIX" npm link --no-audit --no-fund) >/dev/null
(cd "$ROOT/packages/mcp" && npm_config_prefix="$PREFIX" npm link --no-audit --no-fund) >/dev/null

echo "motionfield CLI + motionfield-mcp + motionfield-mcp-http linked into $PREFIX/bin"
echo "If 'motionfield'/'motionfield-mcp'/'motionfield-mcp-http' is not found, add $PREFIX/bin to your PATH."
