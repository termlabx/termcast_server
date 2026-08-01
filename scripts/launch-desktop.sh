#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$ROOT/relay-server"
DESKTOP_DIR="$ROOT/relay-desktop"

echo "=== ttyd Desktop App ==="

# 1. Build relay-server
echo "[1/3] Building relay-server..."
cd "$SERVER_DIR"
npm install --silent
npm run build

# 2. Build relay-desktop
echo "[2/3] Building relay-desktop..."
cd "$DESKTOP_DIR"
npm install --silent
npm run build

# 3. Launch Electron
echo "[3/3] Launching desktop app..."
npx electron dist/main.js
