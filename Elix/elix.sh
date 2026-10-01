#!/usr/bin/env bash
# Elix Unix wrapper. Prefers the built release; falls back to tsx (dev).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$DIR/dist/cli/index.js" ]; then
  exec node "$DIR/dist/cli/index.js" "$@"
else
  exec "$DIR/node_modules/.bin/tsx" "$DIR/src/cli/index.ts" "$@"
fi
