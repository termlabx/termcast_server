#!/usr/bin/env bash
set -euo pipefail

# Build a self-contained tmux for macOS arm64 (native on Apple Silicon)
#
# tmux is shipped as a single downloadable binary (relay-server/bin/tmux-darwin-arm64,
# uploaded to Cloudflare KV by build-release.sh and fetched by the npm postinstall /
# install.sh). The lookup in src/{ttyd,termcastd}-manager.ts returns the bundled path
# without testing it, so the binary MUST run on a clean Mac — i.e. it cannot depend on
# Homebrew dylibs that the target may not have installed.
#
# We therefore statically link libevent, ncurses and utf8proc (the only non-system
# deps), leaving the result linked against just /usr/lib/libSystem and /usr/lib/libresolv
# — present on every macOS. utf8proc is built from source here because Homebrew only ships
# its dylib; it gives tmux accurate Unicode/emoji cell widths (matching the Homebrew tmux
# users get via the system-tmux fallback, so the bundled binary is not a downgrade). The
# trick for forcing static linkage on macOS (where `ld` prefers a .dylib over a .a in the
# same -L dir) is a staging dir that contains ONLY the .a archives, placed first on the
# link path.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/relay-server/bin"
BUILD_DIR="/tmp/tmux-arm64-build"
STATIC_DIR="$BUILD_DIR/static-libs"
TMUX_VERSION="3.6"
UTF8PROC_VERSION="2.9.0"

echo "=== Building tmux ${TMUX_VERSION} for macOS arm64 ==="

if [ "$(uname -m)" != "arm64" ]; then
  echo "Error: This script must be run on Apple Silicon (arm64)"
  exit 1
fi

brew install libevent ncurses bison 2>/dev/null || true

LIBEVENT="$(brew --prefix libevent)"
NCURSES="$(brew --prefix ncurses)"
export PATH="$(brew --prefix bison)/bin:$PATH"  # tmux needs a modern yacc/bison

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$STATIC_DIR" "$BIN_DIR"

# ── Staging dir of static archives only (so -levent_core / -lncursesw pick the .a) ──
cp "$LIBEVENT/lib/libevent_core.a" "$STATIC_DIR/libevent_core.a"
cp "$LIBEVENT/lib/libevent.a"      "$STATIC_DIR/libevent.a"
cp "$NCURSES/lib/libncursesw.a"    "$STATIC_DIR/libncursesw.a"
ln -sf libncursesw.a "$STATIC_DIR/libtinfo.a"

# ── Build utf8proc statically (Homebrew ships only its dylib) ─────────────────────
echo "[1/3] Building utf8proc ${UTF8PROC_VERSION} (static)..."
curl -fsSL -o "$BUILD_DIR/utf8proc.tar.gz" \
  "https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v${UTF8PROC_VERSION}.tar.gz"
tar xzf "$BUILD_DIR/utf8proc.tar.gz" -C "$BUILD_DIR"
UTF8PROC_SRC="$BUILD_DIR/utf8proc-${UTF8PROC_VERSION}"
make -C "$UTF8PROC_SRC" CC=clang -j"$(sysctl -n hw.ncpu)" libutf8proc.a
cp "$UTF8PROC_SRC/libutf8proc.a" "$STATIC_DIR/libutf8proc.a"

# ── Build tmux ──────────────────────────────────────────────────────────────────
echo "[2/3] Fetching + configuring tmux ${TMUX_VERSION}..."
curl -fsSL -o "$BUILD_DIR/tmux.tar.gz" \
  "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"
tar xzf "$BUILD_DIR/tmux.tar.gz" -C "$BUILD_DIR"
cd "$BUILD_DIR/tmux-${TMUX_VERSION}"

./configure \
  --enable-utf8proc \
  CC="clang" \
  CFLAGS="-I$LIBEVENT/include -I$NCURSES/include -I$NCURSES/include/ncursesw -I$UTF8PROC_SRC" \
  LDFLAGS="-L$STATIC_DIR" \
  LIBEVENT_CFLAGS="-I$LIBEVENT/include" \
  LIBEVENT_LIBS="-L$STATIC_DIR -levent_core" \
  LIBNCURSES_CFLAGS="-I$NCURSES/include -I$NCURSES/include/ncursesw" \
  LIBNCURSES_LIBS="-L$STATIC_DIR -lncursesw" \
  LIBUTF8PROC_CFLAGS="-I$UTF8PROC_SRC" \
  LIBUTF8PROC_LIBS="-L$STATIC_DIR -lutf8proc"

echo "[3/3] Compiling..."
make -j"$(sysctl -n hw.ncpu)"

cp tmux "$BIN_DIR/tmux-darwin-arm64"
chmod +x "$BIN_DIR/tmux-darwin-arm64"

echo ""
echo "=== Link dependencies (must be system-only: libSystem, libresolv) ==="
otool -L "$BIN_DIR/tmux-darwin-arm64"
if otool -L "$BIN_DIR/tmux-darwin-arm64" | grep -q "/opt/homebrew\|/usr/local/opt"; then
  echo "ERROR: binary still links a Homebrew dylib — it will not run on a clean Mac."
  exit 1
fi
echo "  OK — no Homebrew dylibs"

echo ""
echo "=== Smoke test ==="
"$BIN_DIR/tmux-darwin-arm64" -V

echo ""
echo "=== tmux-darwin-arm64 built successfully ==="
ls -lh "$BIN_DIR/tmux-darwin-arm64"

rm -rf "$BUILD_DIR"
