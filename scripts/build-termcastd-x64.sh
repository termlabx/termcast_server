#!/usr/bin/env bash
set -euo pipefail

# Cross-compile termcastd for macOS x86_64 on Apple Silicon using Rosetta
#
# Prerequisites: Rosetta 2 (softwareupdate --install-rosetta)
# This script installs x86_64 Homebrew to /usr/local if not present,
# builds termcastd dependencies for x86_64, and produces the final binary.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/relay-server/bin"
BUILD_DIR="/tmp/termcastd-x64-build"
TTYD_VERSION="1.7.7"

echo "=== Cross-compiling termcastd ${TTYD_VERSION} for macOS x86_64 ==="

# Verify Rosetta
if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
  echo "Error: Rosetta 2 is required. Install with:"
  echo "  softwareupdate --install-rosetta"
  exit 1
fi

# Install x86_64 Homebrew if not present
if [ ! -x /usr/local/bin/brew ]; then
  echo "[1/3] Installing x86_64 Homebrew to /usr/local..."
  NONINTERACTIVE=1 arch -x86_64 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
  echo "[1/3] x86_64 Homebrew already installed at /usr/local"
fi

# Install dependencies under x86_64
echo "[2/3] Installing x86_64 build dependencies..."
arch -x86_64 /usr/local/bin/brew install cmake json-c libwebsockets libuv openssl@3 2>/dev/null || true

# Build termcastd
echo "[3/3] Building termcastd for x86_64..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Clone termcastd source
git clone --depth 1 --branch "$TTYD_VERSION" https://github.com/tsl0922/termcastd.git "$BUILD_DIR/termcastd"

# Build under Rosetta
arch -x86_64 /bin/bash << 'BUILDSCRIPT'
set -euo pipefail
export PATH="/usr/local/bin:$PATH"
BUILD_DIR="/tmp/termcastd-x64-build"
cd "$BUILD_DIR/termcastd"
mkdir -p build && cd build

cmake .. \
  -DCMAKE_OSX_ARCHITECTURES=x86_64 \
  -DCMAKE_PREFIX_PATH="/usr/local" \
  -DOPENSSL_ROOT_DIR="/usr/local/opt/openssl@3" \
  -DCMAKE_BUILD_TYPE=Release

make -j$(sysctl -n hw.ncpu)
BUILDSCRIPT

# Copy binary
mkdir -p "$BIN_DIR"
cp "$BUILD_DIR/termcastd/build/termcastd" "$BIN_DIR/termcastd-darwin-x64"
chmod +x "$BIN_DIR/termcastd-darwin-x64"

# Verify
file "$BIN_DIR/termcastd-darwin-x64"
echo ""
echo "=== termcastd-darwin-x64 built successfully ==="
ls -lh "$BIN_DIR/termcastd-darwin-x64"

# Cleanup
rm -rf "$BUILD_DIR"
