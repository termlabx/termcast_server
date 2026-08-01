#!/usr/bin/env bash
set -euo pipefail

# Cross-compile a self-contained tmux for macOS x86_64 on Apple Silicon via Rosetta.
#
# Same goal as build-tmux-arm64.sh (single binary, no Homebrew dylib deps) but built
# under the x86_64 Homebrew at /usr/local. Mirrors scripts/build-termcastd-x64.sh.
#
# Prerequisites: Rosetta 2 (softwareupdate --install-rosetta). This script installs
# x86_64 Homebrew to /usr/local if not present, then builds tmux statically linked
# against x86_64 libevent + ncurses.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/relay-server/bin"
BUILD_DIR="/tmp/tmux-x64-build"
TMUX_VERSION="3.6"
UTF8PROC_VERSION="2.9.0"

echo "=== Cross-compiling tmux ${TMUX_VERSION} for macOS x86_64 ==="

if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
  echo "Error: Rosetta 2 is required. Install with:"
  echo "  softwareupdate --install-rosetta"
  exit 1
fi

if [ ! -x /usr/local/bin/brew ]; then
  echo "[1/3] Installing x86_64 Homebrew to /usr/local..."
  NONINTERACTIVE=1 arch -x86_64 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
  echo "[1/3] x86_64 Homebrew already installed at /usr/local"
fi

echo "[2/3] Installing x86_64 build dependencies..."
arch -x86_64 /usr/local/bin/brew install libevent ncurses bison 2>/dev/null || true

echo "[3/3] Building tmux for x86_64..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$BIN_DIR"
curl -fsSL -o "$BUILD_DIR/tmux.tar.gz" \
  "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"
tar xzf "$BUILD_DIR/tmux.tar.gz" -C "$BUILD_DIR"
curl -fsSL -o "$BUILD_DIR/utf8proc.tar.gz" \
  "https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v${UTF8PROC_VERSION}.tar.gz"
tar xzf "$BUILD_DIR/utf8proc.tar.gz" -C "$BUILD_DIR"

arch -x86_64 /bin/bash << 'BUILDSCRIPT'
set -euo pipefail
export PATH="/usr/local/bin:$PATH"
BUILD_DIR="/tmp/tmux-x64-build"
TMUX_VERSION="3.6"
UTF8PROC_VERSION="2.9.0"
LIBEVENT="$(/usr/local/bin/brew --prefix libevent)"
NCURSES="$(/usr/local/bin/brew --prefix ncurses)"
export PATH="$(/usr/local/bin/brew --prefix bison)/bin:$PATH"

# Staging dir of static archives only (force static linkage on macOS).
STATIC_DIR="$BUILD_DIR/static-libs"
rm -rf "$STATIC_DIR"; mkdir -p "$STATIC_DIR"
cp "$LIBEVENT/lib/libevent_core.a" "$STATIC_DIR/libevent_core.a"
cp "$LIBEVENT/lib/libevent.a"      "$STATIC_DIR/libevent.a"
cp "$NCURSES/lib/libncursesw.a"    "$STATIC_DIR/libncursesw.a"
ln -sf libncursesw.a "$STATIC_DIR/libtinfo.a"

# utf8proc statically (Homebrew ships only its dylib).
UTF8PROC_SRC="$BUILD_DIR/utf8proc-${UTF8PROC_VERSION}"
make -C "$UTF8PROC_SRC" CC="clang -arch x86_64" -j"$(sysctl -n hw.ncpu)" libutf8proc.a
cp "$UTF8PROC_SRC/libutf8proc.a" "$STATIC_DIR/libutf8proc.a"

cd "$BUILD_DIR/tmux-${TMUX_VERSION}"
./configure \
  --enable-utf8proc \
  CC="clang -arch x86_64" \
  CFLAGS="-I$LIBEVENT/include -I$NCURSES/include -I$NCURSES/include/ncursesw -I$UTF8PROC_SRC" \
  LDFLAGS="-L$STATIC_DIR" \
  LIBEVENT_CFLAGS="-I$LIBEVENT/include" \
  LIBEVENT_LIBS="-L$STATIC_DIR -levent_core" \
  LIBNCURSES_CFLAGS="-I$NCURSES/include -I$NCURSES/include/ncursesw" \
  LIBNCURSES_LIBS="-L$STATIC_DIR -lncursesw" \
  LIBUTF8PROC_CFLAGS="-I$UTF8PROC_SRC" \
  LIBUTF8PROC_LIBS="-L$STATIC_DIR -lutf8proc"
make -j"$(sysctl -n hw.ncpu)"
BUILDSCRIPT

cp "$BUILD_DIR/tmux-${TMUX_VERSION}/tmux" "$BIN_DIR/tmux-darwin-x64"
chmod +x "$BIN_DIR/tmux-darwin-x64"

echo ""
echo "=== Link dependencies (must be system-only: libSystem, libresolv) ==="
otool -L "$BIN_DIR/tmux-darwin-x64"
if otool -L "$BIN_DIR/tmux-darwin-x64" | grep -q "/opt/homebrew\|/usr/local/opt"; then
  echo "ERROR: binary still links a Homebrew dylib — it will not run on a clean Mac."
  exit 1
fi
echo "  OK — no Homebrew dylibs"

file "$BIN_DIR/tmux-darwin-x64"
echo ""
echo "=== tmux-darwin-x64 built successfully ==="
ls -lh "$BIN_DIR/tmux-darwin-x64"

rm -rf "$BUILD_DIR"
