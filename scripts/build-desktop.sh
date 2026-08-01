#!/usr/bin/env bash
set -euo pipefail

# Build the Termcast desktop app from source.
#
# Produces an unsigned .app / .dmg by default — enough to run and develop
# against. Signing and notarizing requires your own Apple Developer ID; see
# "Signing" below. The maintainer's release pipeline (Cloudflare KV upload,
# Homebrew tap, notarization) is not part of this repository.
#
# Usage:
#   ./scripts/build-desktop.sh            # build unsigned
#   ./scripts/build-desktop.sh --sign     # build signed + notarized (needs creds)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_DIR="$ROOT/relay-desktop"
SERVER_DIR="$ROOT/relay-server"

SIGN=0
[ "${1:-}" = "--sign" ] && SIGN=1

VERSION=$(node -p "require('$DESKTOP_DIR/package.json').version")
echo "=== Building Termcast Desktop v${VERSION} ==="

# ── Signing credentials ──────────────────────────────────────────
# Only required with --sign. We prompt rather than fail so an interactive
# build is not a dead end, but never store or echo the password.
if [ "$SIGN" = "1" ]; then
  if [ -z "${APPLE_ID:-}" ]; then
    read -r -p "Apple ID (email): " APPLE_ID
  fi
  if [ -z "${APPLE_TEAM_ID:-}" ]; then
    read -r -p "Apple Team ID: " APPLE_TEAM_ID
  fi
  if [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
    echo "App-specific password (appleid.apple.com -> Sign-In and Security)"
    read -r -s -p "Password: " APPLE_APP_SPECIFIC_PASSWORD
    echo ""
  fi
  export APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD

  if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
    echo "error: no 'Developer ID Application' certificate in your keychain." >&2
    echo "Install one from developer.apple.com, or build without --sign." >&2
    exit 1
  fi
fi

# ── 1. Build the daemon ──────────────────────────────────────────
echo "[1/4] Building relay-server..."
cd "$SERVER_DIR"
npm install --silent
npm run build
echo "  Installing production dependencies (these get bundled)..."
npm install --omit=dev --silent

# ── 2. Check native binaries ─────────────────────────────────────
echo "[2/4] Checking native binaries..."
ARCH=$(uname -m)
case "$ARCH" in
  arm64|aarch64) TTYD_ARCH="arm64" ;;
  x86_64)        TTYD_ARCH="x64" ;;
  *)             echo "error: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
TTYD_BIN="ttyd-${PLATFORM}-${TTYD_ARCH}"

if [ ! -f "$SERVER_DIR/bin/$TTYD_BIN" ]; then
  echo "  warning: $SERVER_DIR/bin/$TTYD_BIN not found — the app will not"
  echo "  open a terminal without it. Get one with:"
  echo "    ./scripts/fetch-ttyd-binaries.sh"
  echo "  or compile it: ./scripts/build-ttyd-${TTYD_ARCH}.sh"
fi

# ── 3. Build the app ─────────────────────────────────────────────
echo "[3/4] Building desktop app..."
cd "$DESKTOP_DIR"
npm install --silent
npm run build

# ── 4. Package ───────────────────────────────────────────────────
echo "[4/4] Packaging..."
if [ "$SIGN" = "1" ]; then
  npx electron-builder --mac --publish never
else
  # CSC_IDENTITY_AUTO_DISCOVERY=false stops electron-builder from picking up a
  # stray keychain identity and producing a build signed with something the
  # developer did not choose.
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --publish never
fi

DMG_FILE=$(find "$DESKTOP_DIR/release" -maxdepth 1 -name "*.dmg" | head -1)
if [ -z "$DMG_FILE" ]; then
  echo "error: no DMG produced in $DESKTOP_DIR/release/" >&2
  exit 1
fi

echo ""
echo "Built: $DMG_FILE ($(du -h "$DMG_FILE" | cut -f1))"
if [ "$SIGN" = "0" ]; then
  echo ""
  echo "This build is unsigned. macOS will refuse to open it normally —"
  echo "right-click the app and choose Open, or run:"
  echo "  xattr -dr com.apple.quarantine /Applications/Termcast.app"
fi
