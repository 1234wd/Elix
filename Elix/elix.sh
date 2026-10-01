#!/usr/bin/env bash
# Elix launcher for Linux/macOS. Run `elix start` from any folder.
#
# Prefers the built release (dist/cli/index.js); falls back to running the
# TypeScript sources with tsx so `elix start` works before `pnpm build`.
#
# Add this folder to PATH, or symlink it:
#     ln -s "$PWD/elix.sh" /usr/local/bin/elix
set -euo pipefail

ELIX_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$ELIX_HOME/dist/cli/index.js" ]; then
  exec node "$ELIX_HOME/dist/cli/index.js" "$@"
elif [ -x "$ELIX_HOME/node_modules/.bin/tsx" ]; then
  exec "$ELIX_HOME/node_modules/.bin/tsx" "$ELIX_HOME/src/cli/bin.ts" "$@"
else
  echo "Elix is not installed here. Run this in $ELIX_HOME:" >&2
  echo "    pnpm install" >&2
  echo "    pnpm build" >&2
  exit 1
fi