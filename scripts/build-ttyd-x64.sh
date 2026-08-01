#!/usr/bin/env bash
set -euo pipefail

# Cross-compile ttyd for macOS x86_64 on Apple Silicon using Rosetta
#
# Builds libwebsockets from source with LWS_WITH_EVLIB_PLUGINS=OFF and links
# ttyd against that static lib, so dlopen("libwebsockets-evlib_uv.dylib")
# never happens at runtime.
#
# Prerequisites: Rosetta 2 (softwareupdate --install-rosetta)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/relay-server/bin"
BUILD_DIR="/tmp/ttyd-x64-build"
LWS_INSTALL="$BUILD_DIR/lws-install"
TTYD_VERSION="1.7.7"
LWS_VERSION="4.3.3"

echo "=== Cross-compiling ttyd ${TTYD_VERSION} for macOS x86_64 ==="

if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
  echo "Error: Rosetta 2 is required. Install with:"
  echo "  softwareupdate --install-rosetta"
  exit 1
fi

# Install x86_64 Homebrew if not present
if [ ! -x /usr/local/bin/brew ]; then
  echo "[0/3] Installing x86_64 Homebrew to /usr/local..."
  NONINTERACTIVE=1 arch -x86_64 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
  echo "[0/3] x86_64 Homebrew already installed at /usr/local"
fi

arch -x86_64 /usr/local/bin/brew install cmake json-c libuv openssl@3 2>/dev/null || true

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$LWS_INSTALL"

# ── Build + install libwebsockets statically, evlib plugins off (x86_64) ──────
echo "[1/3] Building libwebsockets ${LWS_VERSION} (static, no evlib plugins)..."
git clone --depth 1 --branch "v${LWS_VERSION}" \
  https://github.com/warmcat/libwebsockets.git "$BUILD_DIR/libwebsockets"

arch -x86_64 /bin/bash <<BUILDLWS
set -euo pipefail
export PATH="/usr/local/bin:\$PATH"
mkdir -p "$BUILD_DIR/libwebsockets/build"
cd "$BUILD_DIR/libwebsockets/build"
cmake .. \\
  -DCMAKE_OSX_ARCHITECTURES=x86_64 \\
  -DCMAKE_INSTALL_PREFIX="$LWS_INSTALL" \\
  -DCMAKE_PREFIX_PATH="/usr/local" \\
  -DOPENSSL_ROOT_DIR="/usr/local/opt/openssl@3" \\
  -DLWS_WITH_LIBUV=ON \\
  -DLWS_WITH_EVLIB_PLUGINS=OFF \\
  -DLWS_WITH_SHARED=OFF \\
  -DLWS_WITH_STATIC=ON \\
  -DLWS_WITHOUT_TESTAPPS=ON \\
  -DLWS_WITHOUT_TEST_SERVER=ON \\
  -DLWS_WITHOUT_TEST_PING=ON \\
  -DLWS_WITHOUT_TEST_CLIENT=ON \\
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \\
  -DCMAKE_BUILD_TYPE=Release
make -j\$(sysctl -n hw.ncpu)
make install
BUILDLWS

# LWS cmake config unconditionally lists websockets_shared — remove it.
LWS_CONFIG="$LWS_INSTALL/lib/cmake/libwebsockets/libwebsockets-config.cmake"
sed -i '' 's/set(LIBWEBSOCKETS_LIBRARIES websockets websockets_shared)/set(LIBWEBSOCKETS_LIBRARIES websockets)/' \
  "$LWS_CONFIG"

# ── Clone ttyd ────────────────────────────────────────────────────────────────
echo "[2/3] Cloning ttyd ${TTYD_VERSION}..."
git clone --depth 1 --branch "$TTYD_VERSION" \
  https://github.com/tsl0922/ttyd.git "$BUILD_DIR/ttyd"

# ── Build ttyd against static LWS (x86_64 via Rosetta) ───────────────────────
echo "[3/3] Building ttyd..."
arch -x86_64 /bin/bash <<BUILDTTYD
set -euo pipefail
export PATH="/usr/local/bin:\$PATH"
mkdir -p "$BUILD_DIR/ttyd/build"
cd "$BUILD_DIR/ttyd/build"
cmake .. \\
  -DCMAKE_OSX_ARCHITECTURES=x86_64 \\
  -DCMAKE_PREFIX_PATH="$LWS_INSTALL;/usr/local/opt/libuv;/usr/local/opt/json-c;/usr/local/opt/openssl@3" \\
  -DOPENSSL_ROOT_DIR="/usr/local/opt/openssl@3" \\
  -DCMAKE_BUILD_TYPE=Release
make -j\$(sysctl -n hw.ncpu)
BUILDTTYD

mkdir -p "$BIN_DIR"
cp "$BUILD_DIR/ttyd/build/ttyd" "$BIN_DIR/ttyd-darwin-x64"
chmod +x "$BIN_DIR/ttyd-darwin-x64"

echo ""
echo "=== Link dependencies ==="
otool -L "$BIN_DIR/ttyd-darwin-x64"
echo ""
echo "Checking for evlib (should print nothing):"
otool -L "$BIN_DIR/ttyd-darwin-x64" | grep evlib || echo "  OK — no evlib dylib"

echo ""
echo "=== ttyd-darwin-x64 built successfully ==="
ls -lh "$BIN_DIR/ttyd-darwin-x64"

rm -rf "$BUILD_DIR"
