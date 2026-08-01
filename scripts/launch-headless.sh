#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$ROOT/relay-server"

# Parse args
# No default relay: set RELAY_URL (or TERMCAST_RELAY_URL) to your own.
RELAY_URL="${RELAY_URL:-${TERMCAST_RELAY_URL:-}}"
if [ -z "$RELAY_URL" ]; then
  echo "error: no relay configured. Set RELAY_URL, e.g." >&2
  echo "  RELAY_URL=wss://relay.example.com $0" >&2
  exit 1
fi
WEB_PORT="${WEB_PORT:-8080}"
TTYD_PORT="${TTYD_PORT:-7681}"
SHELL_CMD="${SHELL_CMD:-${SHELL:-/bin/bash}}"

echo "=== ttyd Headless Server ==="
echo "Relay:    $RELAY_URL"
echo "Web UI:   http://127.0.0.1:$WEB_PORT"
echo "Shell:    $SHELL_CMD"
echo ""

# Build relay-server
echo "[1/2] Building relay-server..."
cd "$SERVER_DIR"
npm install --silent
npm run build

# Launch server directly (no Electron needed)
echo "[2/2] Starting server..."
echo ""
node dist/index.js start \
  --relay "$RELAY_URL" \
  --port "$TTYD_PORT" \
  --web-port "$WEB_PORT" \
  --shell "$SHELL_CMD"
