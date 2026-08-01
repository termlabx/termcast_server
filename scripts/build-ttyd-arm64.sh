#!/usr/bin/env bash
set -euo pipefail

# Build ttyd for macOS arm64 (native on Apple Silicon)
#
# Builds libwebsockets from source with LWS_WITH_EVLIB_PLUGINS=OFF and links
# ttyd against that static lib, so dlopen("libwebsockets-evlib_uv.dylib")
# never happens at runtime. The other deps (libuv, json-c, openssl) remain
# as dynamic Homebrew libs — they are standard and present on any Mac with
# Homebrew; the evlib plugin is the only one missing on clean systems.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/relay-server/bin"
BUILD_DIR="/tmp/ttyd-arm64-build"
LWS_INSTALL="$BUILD_DIR/lws-install"
TTYD_VERSION="1.7.7"
LWS_VERSION="4.3.3"

echo "=== Building ttyd ${TTYD_VERSION} for macOS arm64 ==="

if [ "$(uname -m)" != "arm64" ]; then
  echo "Error: This script must be run on Apple Silicon (arm64)"
  exit 1
fi

brew install cmake json-c libuv openssl@3 2>/dev/null || true

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$LWS_INSTALL"

BREW_PREFIX="$(brew --prefix)"

# ── Build + install libwebsockets statically, evlib plugins off ───────────────
echo "[1/3] Building libwebsockets ${LWS_VERSION} (static, no evlib plugins)..."
git clone --depth 1 --branch "v${LWS_VERSION}" \
  https://github.com/warmcat/libwebsockets.git "$BUILD_DIR/libwebsockets"

mkdir -p "$BUILD_DIR/libwebsockets/build"
cd "$BUILD_DIR/libwebsockets/build"
cmake .. \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_INSTALL_PREFIX="$LWS_INSTALL" \
  -DCMAKE_PREFIX_PATH="$BREW_PREFIX" \
  -DOPENSSL_ROOT_DIR="$BREW_PREFIX/opt/openssl@3" \
  -DLWS_WITH_LIBUV=ON \
  -DLWS_WITH_EVLIB_PLUGINS=OFF \
  -DLWS_WITH_SHARED=OFF \
  -DLWS_WITH_STATIC=ON \
  -DLWS_WITHOUT_TESTAPPS=ON \
  -DLWS_WITHOUT_TEST_SERVER=ON \
  -DLWS_WITHOUT_TEST_PING=ON \
  -DLWS_WITHOUT_TEST_CLIENT=ON \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_BUILD_TYPE=Release
make -j"$(sysctl -n hw.ncpu)"
make install

# LWS cmake config unconditionally lists websockets_shared in LIBWEBSOCKETS_LIBRARIES
# even when only the static lib was built — remove it so ttyd's linker doesn't choke.
LWS_CONFIG="$LWS_INSTALL/lib/cmake/libwebsockets/libwebsockets-config.cmake"
sed -i '' 's/set(LIBWEBSOCKETS_LIBRARIES websockets websockets_shared)/set(LIBWEBSOCKETS_LIBRARIES websockets)/' \
  "$LWS_CONFIG"

# ── Clone ttyd ────────────────────────────────────────────────────────────────
echo "[2/3] Cloning ttyd ${TTYD_VERSION}..."
git clone --depth 1 --branch "$TTYD_VERSION" \
  https://github.com/tsl0922/ttyd.git "$BUILD_DIR/ttyd"

# ── Build ttyd against the static LWS (install prefix first → cmake finds it) ─
echo "[3/3] Building ttyd..."
mkdir -p "$BUILD_DIR/ttyd/build"
cd "$BUILD_DIR/ttyd/build"
cmake .. \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_PREFIX_PATH="$LWS_INSTALL;$BREW_PREFIX/opt/libuv;$BREW_PREFIX/opt/json-c;$BREW_PREFIX/opt/openssl@3" \
  -DOPENSSL_ROOT_DIR="$BREW_PREFIX/opt/openssl@3" \
  -DCMAKE_BUILD_TYPE=Release
make -j"$(sysctl -n hw.ncpu)"

mkdir -p "$BIN_DIR"
cp "$BUILD_DIR/ttyd/build/ttyd" "$BIN_DIR/ttyd-darwin-arm64"
chmod +x "$BIN_DIR/ttyd-darwin-arm64"

echo ""
echo "=== Link dependencies ==="
otool -L "$BIN_DIR/ttyd-darwin-arm64"
echo ""
echo "Checking for evlib (should print nothing):"
otool -L "$BIN_DIR/ttyd-darwin-arm64" | grep evlib || echo "  OK — no evlib dylib"

echo ""
echo "=== ttyd-darwin-arm64 built successfully ==="
ls -lh "$BIN_DIR/ttyd-darwin-arm64"

rm -rf "$BUILD_DIR"
