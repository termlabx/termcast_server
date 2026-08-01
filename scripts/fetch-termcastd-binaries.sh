#!/usr/bin/env bash
set -euo pipefail

# Fetch/verify all termcastd binaries for distribution via Cloudflare KV
#
# Expected files in relay-server/bin/:
#   termcastd-darwin-arm64   (built locally — see README)
#   termcastd-darwin-x64     (cross-compiled — see build-termcastd-x64.sh)
#   termcastd-linux-x64      (downloaded from GitHub)
#   termcastd-linux-arm64    (downloaded from GitHub)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/relay-server/bin"
TTYD_VERSION="1.7.7"
GH_BASE="https://github.com/tsl0922/termcastd/releases/download/${TTYD_VERSION}"

mkdir -p "$BIN_DIR"

echo "=== Fetching termcastd ${TTYD_VERSION} binaries ==="

MISSING=0

# ── macOS arm64 (must be pre-built) ─────────────────────────────
if [ -f "$BIN_DIR/termcastd-darwin-arm64" ]; then
  echo "[1/4] termcastd-darwin-arm64 — OK ($(du -h "$BIN_DIR/termcastd-darwin-arm64" | cut -f1))"
else
  echo "[1/4] termcastd-darwin-arm64 — MISSING (build locally on arm64 Mac)"
  MISSING=$((MISSING + 1))
fi

# ── macOS x64 (must be cross-compiled) ──────────────────────────
if [ -f "$BIN_DIR/termcastd-darwin-x64" ]; then
  echo "[2/4] termcastd-darwin-x64 — OK ($(du -h "$BIN_DIR/termcastd-darwin-x64" | cut -f1))"
else
  echo "[2/4] termcastd-darwin-x64 — MISSING (run: bash scripts/build-termcastd-x64.sh)"
  MISSING=$((MISSING + 1))
fi

# ── Linux x64 (from GitHub) ─────────────────────────────────────
if [ -f "$BIN_DIR/termcastd-linux-x64" ]; then
  echo "[3/4] termcastd-linux-x64 — already exists ($(du -h "$BIN_DIR/termcastd-linux-x64" | cut -f1))"
else
  echo "[3/4] Downloading termcastd-linux-x64..."
  curl -fsSL "$GH_BASE/termcastd.x86_64" -o "$BIN_DIR/termcastd-linux-x64"
  chmod +x "$BIN_DIR/termcastd-linux-x64"
  echo "  Done ($(du -h "$BIN_DIR/termcastd-linux-x64" | cut -f1))"
fi

# ── Linux arm64 (from GitHub) ───────────────────────────────────
if [ -f "$BIN_DIR/termcastd-linux-arm64" ]; then
  echo "[4/4] termcastd-linux-arm64 — already exists ($(du -h "$BIN_DIR/termcastd-linux-arm64" | cut -f1))"
else
  echo "[4/4] Downloading termcastd-linux-arm64..."
  curl -fsSL "$GH_BASE/termcastd.aarch64" -o "$BIN_DIR/termcastd-linux-arm64"
  chmod +x "$BIN_DIR/termcastd-linux-arm64"
  echo "  Done ($(du -h "$BIN_DIR/termcastd-linux-arm64" | cut -f1))"
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
if [ "$MISSING" -gt 0 ]; then
  echo "=== WARNING: $MISSING macOS binary(s) missing — build before uploading ==="
else
  echo "=== All 4 binaries ready ==="
fi
ls -lh "$BIN_DIR"/termcastd-* 2>/dev/null || true
