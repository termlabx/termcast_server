#!/usr/bin/env bash
set -euo pipefail

# Fetch/verify all tmux binaries for distribution via Cloudflare KV.
#
# These are what the Worker serves at /releases/tmux-{platform}-{arch} and what the
# npm @termcast/cli postinstall + install.sh download (best-effort; the server falls
# back to system tmux or a bare shell if missing). build-release.sh uploads whatever
# tmux-* files are present in relay-server/bin/.
#
# Expected files in relay-server/bin/:
#   tmux-darwin-arm64   (built locally — run: bash scripts/build-tmux-arm64.sh)
#   tmux-darwin-x64     (cross-compiled — run: bash scripts/build-tmux-x64.sh)
#   tmux-linux-x64      (downloaded here — static musl build)
#   tmux-linux-arm64    (downloaded here — static musl build)
#
# Linux binaries come prebuilt and statically linked from pythops/tmux-linux-binary.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/relay-server/bin"
TMUX_LINUX_TAG="v3.6b"
GH_BASE="https://github.com/pythops/tmux-linux-binary/releases/download/${TMUX_LINUX_TAG}"

mkdir -p "$BIN_DIR"

echo "=== Fetching tmux binaries ==="

MISSING=0

# ── macOS arm64 (must be pre-built) ─────────────────────────────
if [ -f "$BIN_DIR/tmux-darwin-arm64" ]; then
  echo "[1/4] tmux-darwin-arm64 — OK ($(du -h "$BIN_DIR/tmux-darwin-arm64" | cut -f1))"
else
  echo "[1/4] tmux-darwin-arm64 — MISSING (run: bash scripts/build-tmux-arm64.sh)"
  MISSING=$((MISSING + 1))
fi

# ── macOS x64 (must be cross-compiled) ──────────────────────────
if [ -f "$BIN_DIR/tmux-darwin-x64" ]; then
  echo "[2/4] tmux-darwin-x64 — OK ($(du -h "$BIN_DIR/tmux-darwin-x64" | cut -f1))"
else
  echo "[2/4] tmux-darwin-x64 — MISSING (run: bash scripts/build-tmux-x64.sh)"
  MISSING=$((MISSING + 1))
fi

# ── Linux x64 (from GitHub, static) ─────────────────────────────
if [ -f "$BIN_DIR/tmux-linux-x64" ]; then
  echo "[3/4] tmux-linux-x64 — already exists ($(du -h "$BIN_DIR/tmux-linux-x64" | cut -f1))"
else
  echo "[3/4] Downloading tmux-linux-x64..."
  curl -fsSL "$GH_BASE/tmux-linux-x86_64" -o "$BIN_DIR/tmux-linux-x64"
  chmod +x "$BIN_DIR/tmux-linux-x64"
  echo "  Done ($(du -h "$BIN_DIR/tmux-linux-x64" | cut -f1))"
fi

# ── Linux arm64 (from GitHub, static) ───────────────────────────
if [ -f "$BIN_DIR/tmux-linux-arm64" ]; then
  echo "[4/4] tmux-linux-arm64 — already exists ($(du -h "$BIN_DIR/tmux-linux-arm64" | cut -f1))"
else
  echo "[4/4] Downloading tmux-linux-arm64..."
  curl -fsSL "$GH_BASE/tmux-linux-arm64" -o "$BIN_DIR/tmux-linux-arm64"
  chmod +x "$BIN_DIR/tmux-linux-arm64"
  echo "  Done ($(du -h "$BIN_DIR/tmux-linux-arm64" | cut -f1))"
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
if [ "$MISSING" -gt 0 ]; then
  echo "=== WARNING: $MISSING macOS binary(s) missing — build before uploading ==="
else
  echo "=== All 4 binaries ready ==="
fi
ls -lh "$BIN_DIR"/tmux-* 2>/dev/null || true
