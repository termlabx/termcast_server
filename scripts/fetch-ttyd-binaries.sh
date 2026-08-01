#!/usr/bin/env bash
set -euo pipefail

# Fetch/verify all ttyd binaries for distribution via Cloudflare KV
#
# Expected files in relay-server/bin/:
#   ttyd-darwin-arm64   (built locally — see README)
#   ttyd-darwin-x64     (cross-compiled — see build-ttyd-x64.sh)
#   ttyd-linux-x64      (downloaded from GitHub)
#   ttyd-linux-arm64    (downloaded from GitHub)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/relay-server/bin"
TTYD_VERSION="1.7.7"
GH_BASE="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}"

mkdir -p "$BIN_DIR"

echo "=== Fetching ttyd ${TTYD_VERSION} binaries ==="

MISSING=0

# ── macOS arm64 (must be pre-built) ─────────────────────────────
if [ -f "$BIN_DIR/ttyd-darwin-arm64" ]; then
  echo "[1/4] ttyd-darwin-arm64 — OK ($(du -h "$BIN_DIR/ttyd-darwin-arm64" | cut -f1))"
else
  echo "[1/4] ttyd-darwin-arm64 — MISSING (run: bash scripts/build-ttyd-arm64.sh)"
  MISSING=$((MISSING + 1))
fi

# ── macOS x64 (must be cross-compiled) ──────────────────────────
if [ -f "$BIN_DIR/ttyd-darwin-x64" ]; then
  echo "[2/4] ttyd-darwin-x64 — OK ($(du -h "$BIN_DIR/ttyd-darwin-x64" | cut -f1))"
else
  echo "[2/4] ttyd-darwin-x64 — MISSING (run: bash scripts/build-ttyd-x64.sh)"
  MISSING=$((MISSING + 1))
fi

# ── Linux x64 (from GitHub) ─────────────────────────────────────
if [ -f "$BIN_DIR/ttyd-linux-x64" ]; then
  echo "[3/4] ttyd-linux-x64 — already exists ($(du -h "$BIN_DIR/ttyd-linux-x64" | cut -f1))"
else
  echo "[3/4] Downloading ttyd-linux-x64..."
  curl -fsSL "$GH_BASE/ttyd.x86_64" -o "$BIN_DIR/ttyd-linux-x64"
  chmod +x "$BIN_DIR/ttyd-linux-x64"
  echo "  Done ($(du -h "$BIN_DIR/ttyd-linux-x64" | cut -f1))"
fi

# ── Linux arm64 (from GitHub) ───────────────────────────────────
if [ -f "$BIN_DIR/ttyd-linux-arm64" ]; then
  echo "[4/4] ttyd-linux-arm64 — already exists ($(du -h "$BIN_DIR/ttyd-linux-arm64" | cut -f1))"
else
  echo "[4/4] Downloading ttyd-linux-arm64..."
  curl -fsSL "$GH_BASE/ttyd.aarch64" -o "$BIN_DIR/ttyd-linux-arm64"
  chmod +x "$BIN_DIR/ttyd-linux-arm64"
  echo "  Done ($(du -h "$BIN_DIR/ttyd-linux-arm64" | cut -f1))"
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
if [ "$MISSING" -gt 0 ]; then
  echo "=== WARNING: $MISSING macOS binary(s) missing — build before uploading ==="
else
  echo "=== All 4 binaries ready ==="
fi
ls -lh "$BIN_DIR"/ttyd-* 2>/dev/null || true
