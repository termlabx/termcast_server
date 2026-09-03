#!/usr/bin/env bash
set -euo pipefail

# ── Termcast installer ─────────────────────────────────────────────
# Supports: macOS (arm64, x64), Linux (x64, arm64), WSL
#
#   curl -fsSL https://ttyd-relay.xing-mathcoder.workers.dev/install.sh | bash
#
# ──────────────────────────────────────────────────────────────────

INSTALL_DIR="$HOME/.termcast"
BASE_URL="${TERMCAST_RELEASES_URL:-https://ttyd-relay.xing-mathcoder.workers.dev}"
NODE_VERSION="24.13.1"

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "  ${CYAN}$*${NC}"; }
ok()    { echo -e "  ${GREEN}$*${NC}"; }
warn()  { echo -e "  ${YELLOW}$*${NC}"; }
fail()  { echo -e "  ${RED}error: $*${NC}" >&2; exit 1; }
step()  { echo -e "  ${DIM}[$1/$TOTAL_STEPS]${NC} $2"; }

# ── Detect platform ──────────────────────────────────────────────
detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux)   PLATFORM="linux" ;;
    Darwin)  PLATFORM="darwin" ;;
    MINGW*|MSYS*|CYGWIN*)
      fail "Windows is not supported. Use WSL instead:
       wsl --install
       Then run this installer inside WSL." ;;
    *)       fail "Unsupported OS: $OS" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)   NODE_ARCH="x64" ;;
    aarch64|arm64)   NODE_ARCH="arm64" ;;
    armv7l|armv6l)
      fail "32-bit ARM is not supported. Use a 64-bit OS." ;;
    *)
      fail "Unsupported architecture: $ARCH" ;;
  esac

  # Detect WSL
  IS_WSL=false
  if [ "$PLATFORM" = "linux" ] && grep -qi microsoft /proc/version 2>/dev/null; then
    IS_WSL=true
  fi
}

# ── Detect service manager ────────────────────────────────────────
# macOS always has launchd. Linux requires systemd as PID 1 AND a reachable
# --user manager — not just the systemctl binary, which can be present in a
# container with no running user session/D-Bus, and must not be misdetected
# as supported. Falls back to the bash loop otherwise.
detect_service_manager() {
  if [ "$PLATFORM" = "darwin" ]; then
    SERVICE_MANAGER="launchd"
    return
  fi
  if [ -d /run/systemd/system ] && command -v systemctl &>/dev/null && \
     systemctl --user daemon-reload &>/dev/null; then
    SERVICE_MANAGER="systemd"
  else
    SERVICE_MANAGER="loop"
    warn "No usable systemd user session detected — falling back to the built-in supervisor."
  fi
}

# ── Check / install Node.js ──────────────────────────────────────
ensure_node() {
  # Must track the `engines.node` floor in relay-server/package.json. A system
  # Node below it is not an error: we fall through and install the bundled
  # NODE_VERSION under $INSTALL_DIR/node, so old-Node hosts still work.
  if command -v node &>/dev/null; then
    NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 24 ]; then
      step "$CURRENT_STEP" "Node.js $(node -v) detected"
      NODE_BIN="$(command -v node)"
      NPM_BIN="$(command -v npm)"
      return
    fi
    warn "Node.js $(node -v) found but v24+ required — installing bundled version..."
  fi

  # Install Node.js locally
  step "$CURRENT_STEP" "Installing Node.js ${NODE_VERSION}..."

  local NODE_DIR="$INSTALL_DIR/node"
  local NODE_DIST

  case "$PLATFORM" in
    darwin) NODE_DIST="node-v${NODE_VERSION}-darwin-${NODE_ARCH}" ;;
    linux)  NODE_DIST="node-v${NODE_VERSION}-linux-${NODE_ARCH}" ;;
  esac

  local NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.xz"

  mkdir -p "$NODE_DIR"

  # Try tar.xz first (smaller), fall back to tar.gz
  if command -v xz &>/dev/null; then
    curl -fsSL "$NODE_URL" < /dev/null | tar xJ -C "$NODE_DIR" --strip-components=1
  else
    NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.gz"
    curl -fsSL "$NODE_URL" < /dev/null | tar xz -C "$NODE_DIR" --strip-components=1
  fi

  NODE_BIN="$NODE_DIR/bin/node"
  NPM_BIN="$NODE_DIR/bin/npm"
  export PATH="$NODE_DIR/bin:$PATH"

  if [ ! -x "$NODE_BIN" ]; then
    fail "Failed to install Node.js. Download manually from https://nodejs.org"
  fi

  ok "Node.js $("$NODE_BIN" -v) installed"
  BUNDLED_NODE=true
}

# ── Download server ───────────────────────────────────────────────
download_server() {
  step "$CURRENT_STEP" "Downloading Termcast server..."

  mkdir -p "$INSTALL_DIR/bin"

  local TARBALL_URL="$BASE_URL/releases/latest.tar.gz"
  # Capture tar stderr; filter harmless macOS xattr packaging noise before printing
  local TAR_ERR
  TAR_ERR="$(mktemp)"
  if ! curl -fsSL "$TARBALL_URL" < /dev/null | tar xz -C "$INSTALL_DIR" 2>"$TAR_ERR"; then
    cat "$TAR_ERR" >&2
    rm -f "$TAR_ERR"
    fail "Failed to download Termcast server"
  fi
  grep -v "LIBARCHIVE.xattr" "$TAR_ERR" >&2 || true
  rm -f "$TAR_ERR"

  ok "Termcast server extracted"
}

# ── Install npm dependencies ─────────────────────────────────────
install_deps() {
  step "$CURRENT_STEP" "Installing dependencies..."

  cd "$INSTALL_DIR"
  # --ignore-scripts: the tarball ships dist/ + package.json only (no scripts/),
  # but package.json carries a `postinstall` hook for the npm distribution
  # (`node scripts/postinstall.mjs`) that would MODULE_NOT_FOUND here. This
  # installer downloads the native binaries itself (steps below), so the npm
  # lifecycle scripts are neither available nor needed.
  "$NPM_BIN" install --production --ignore-scripts --silent < /dev/null

  ok "Dependencies installed"
}

# ── Download termcastd binary ─────────────────────────────────────
download_binary() {
  step "$CURRENT_STEP" "Downloading termcastd..."

  # The server runtime looks for termcastd-{platform}-{arch}. Naming the file
  # termcastd (not ttyd) is also what makes the process show up as `termcastd`
  # in `ps`/Activity Monitor rather than exposing ttyd to users.
  local BIN_KEY="termcastd-${PLATFORM}-${NODE_ARCH}"
  local BIN_DEST="$INSTALL_DIR/bin/${BIN_KEY}"
  local BIN_URL="$BASE_URL/releases/${BIN_KEY}"

  if curl -fsSL "$BIN_URL" -o "$BIN_DEST" < /dev/null 2>/dev/null && [ -s "$BIN_DEST" ]; then
    chmod +x "$BIN_DEST"
    ok "termcastd downloaded"
  else
    warn "Failed to download termcastd for ${PLATFORM}-${NODE_ARCH}"
    warn "Retry, or reinstall: npm install -g @termcast/cli"
  fi
}

# ── Download tmux binary (optional) ──────────────────────────────
download_tmux() {
  # Skip if tmux is already available system-wide
  if command -v tmux &>/dev/null; then
    ok "tmux already installed ($(tmux -V))"
    return
  fi

  step "$CURRENT_STEP" "Downloading tmux..."

  local BIN_KEY="tmux-${PLATFORM}-${NODE_ARCH}"
  local BIN_DEST="$INSTALL_DIR/bin/${BIN_KEY}"
  local BIN_URL="$BASE_URL/releases/${BIN_KEY}"

  if curl -fsSL "$BIN_URL" -o "$BIN_DEST" < /dev/null 2>/dev/null && [ -s "$BIN_DEST" ]; then
    chmod +x "$BIN_DEST"
    ok "tmux downloaded"
  else
    rm -f "$BIN_DEST"
    warn "tmux not available for ${PLATFORM}-${NODE_ARCH} — server will fall back to a basic shell"
    warn "For the best experience, install tmux: sudo apt install tmux (Linux) / brew install tmux (macOS)"
  fi
}

# ── Create wrapper script ────────────────────────────────────────
create_wrapper() {
  step "$CURRENT_STEP" "Creating termcast command..."

  # Determine node path for wrapper (runtime $HOME expansion for bundled node)
  local NODE_PATH
  if [ "${BUNDLED_NODE:-false}" = true ]; then
    NODE_PATH="\$HOME/.termcast/node/bin/node"
  else
    NODE_PATH="$(command -v node)"
  fi

  # ── Restart loop (separate background process) ───────────────────
  # Keeps the server alive — restarts after crashes. Killed by 'termcast stop'.
  cat > "$INSTALL_DIR/bin/termcast-loop" << 'LOOP'
#!/usr/bin/env bash
NODE_PATH="NODE_PATH_PLACEHOLDER"
SCRIPT="$HOME/.termcast/dist/index.js"
LOG="$HOME/.termcast/termcast.log"
PID_FILE="$HOME/.termcast/termcast.pid"

# Write our own PID so 'termcast stop' can find and kill this loop
SUPERVISOR_PID=$$
echo "$SUPERVISOR_PID" > "$PID_FILE"

CHILD=
cleanup() {
  kill "$CHILD" 2>/dev/null || true
  rm -f "$PID_FILE"
  exit 0
}
trap cleanup TERM INT

# Fixed restart delay, matching the ThrottleInterval/RestartSec the native
# launchd/systemd supervisors use — this loop is now only a fallback for
# environments with neither. Log rotation and 429 backoff both moved out of
# this script: rotation runs in-process in the daemon itself now (it can no
# longer orphan a subshell if this supervisor dies uncleanly), and the
# relay's own reconnect backoff (relay-client.ts, capped at 2h) already
# handles rate limiting without needing a whole-process restart.
RESTART_DELAY="${TERMCAST_RESTART_DELAY:-10}"

while true; do
  "$NODE_PATH" "$SCRIPT" start "$@" >> "$LOG" 2>&1 &
  CHILD=$!
  wait "$CHILD"
  code=$?
  # 0=clean exit  143=SIGTERM  130=SIGINT — stop the loop
  if [ "$code" -eq 0 ] || [ "$code" -eq 143 ] || [ "$code" -eq 130 ]; then
    cleanup
  fi
  pkill -x termcastd 2>/dev/null || true; pkill -x ttyd 2>/dev/null || true
  printf '[%s] Crashed (exit %d), restarting in %ds...\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$code" "$RESTART_DELAY" >> "$LOG"
  sleep "$RESTART_DELAY"
done
LOOP

  sed -i.bak "s|NODE_PATH_PLACEHOLDER|$NODE_PATH|" "$INSTALL_DIR/bin/termcast-loop"
  rm -f "$INSTALL_DIR/bin/termcast-loop.bak"
  chmod +x "$INSTALL_DIR/bin/termcast-loop"

  # ── Main wrapper ─────────────────────────────────────────────────
  cat > "$INSTALL_DIR/bin/termcast" << 'WRAPPER'
#!/usr/bin/env bash
NODE_PATH="NODE_PATH_PLACEHOLDER"
SCRIPT="$HOME/.termcast/dist/index.js"
LOG="$HOME/.termcast/termcast.log"
PID_FILE="$HOME/.termcast/termcast.pid"
LOOP="$HOME/.termcast/bin/termcast-loop"
SERVICE_MANAGER="SERVICE_MANAGER_PLACEHOLDER"   # launchd | systemd | loop
PLIST="$HOME/Library/LaunchAgents/com.termcast.daemon.plist"
UNIT="$HOME/.config/systemd/user/termcast.service"

# Regenerate the launchd job with the current start args baked in.
# `launchctl kickstart` replays whatever definition is currently loaded, not
# the live command line, so this must run before every (re)start.
write_launchd_plist() {
  local args_xml=""
  local arg esc
  for arg in "$@"; do
    esc="${arg//&/&amp;}"
    esc="${esc//</&lt;}"
    esc="${esc//>/&gt;}"
    args_xml="${args_xml}    <string>${esc}</string>
"
  done
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.termcast.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${SCRIPT}</string>
    <string>start</string>
${args_xml}  </array>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
  <key>WorkingDirectory</key><string>${HOME}/.termcast</string>
</dict>
</plist>
PLIST_EOF
}

# Same idea for the systemd unit: rewritten with current args before every
# (re)start, then `daemon-reload` so systemd actually picks up the change.
write_systemd_unit() {
  local exec_args=""
  local arg
  for arg in "$@"; do
    exec_args="${exec_args} $(printf '%q' "$arg")"
  done
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Termcast daemon

[Service]
Type=simple
ExecStart=$(printf '%q' "$NODE_PATH") $(printf '%q' "$SCRIPT") start${exec_args}
Restart=on-failure
RestartSec=10
StandardOutput=append:$(printf '%q' "$LOG")
StandardError=append:$(printf '%q' "$LOG")
WorkingDirectory=$(printf '%q' "$HOME/.termcast")
UNIT_EOF
}

# A legacy termcast-loop supervisor from a prior install, still running —
# must be stopped before native supervision takes over the same identity
# (~/.ttyd-server), or both would fight over the relay room.
legacy_loop_alive() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

case "${1:-}" in
  start)
    shift
    if legacy_loop_alive; then
      echo "Stopping legacy supervisor before switching to native service management..."
      "$0" stop
      sleep 1
    fi
    case "$SERVICE_MANAGER" in
      launchd)
        write_launchd_plist "$@"
        launchctl bootout "gui/$(id -u)/com.termcast.daemon" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$PLIST"
        launchctl kickstart -k "gui/$(id -u)/com.termcast.daemon"
        echo "Termcast started — logs: $LOG"
        sleep 2
        grep -m1 'Web UI\|QR\|Connected\|relay' "$LOG" 2>/dev/null || true
        ;;
      systemd)
        if systemctl --user daemon-reload 2>/dev/null; then
          write_systemd_unit "$@"
          systemctl --user daemon-reload
          loginctl enable-linger "$(whoami)" 2>/dev/null || \
            echo "Note: could not enable linger — Termcast may stop when this session ends. An admin can run: loginctl enable-linger $(whoami)"
          systemctl --user restart termcast
          echo "Termcast started — logs: $LOG"
          sleep 2
          grep -m1 'Web UI\|QR\|Connected\|relay' "$LOG" 2>/dev/null || true
        else
          echo "systemd user session unavailable — falling back to the built-in supervisor."
          SERVICE_MANAGER=loop
        fi
        ;;
    esac
    if [ "$SERVICE_MANAGER" = "loop" ]; then
      if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "Termcast is already running. Use 'termcast restart' to restart."
        exit 0
      fi
      nohup "$LOOP" "$@" > /dev/null 2>&1 &
      disown
      echo "Termcast started — logs: $LOG"
      sleep 2
      grep -m1 'Web UI\|QR\|Connected\|relay' "$LOG" 2>/dev/null || true
    fi
    ;;
  stop)
    case "$SERVICE_MANAGER" in
      launchd)
        launchctl kill SIGTERM "gui/$(id -u)/com.termcast.daemon" 2>/dev/null && echo "Termcast stopped" || echo "Server not running"
        ;;
      systemd)
        systemctl --user stop termcast 2>/dev/null && echo "Termcast stopped" || echo "Server not running"
        ;;
      *)
        if [ -f "$PID_FILE" ]; then
          PID=$(cat "$PID_FILE")
          kill "$PID" 2>/dev/null && echo "Termcast stopped" || echo "Server not running"
          rm -f "$PID_FILE"
        else
          echo "No running server found"
        fi
        ;;
    esac
    # Belt & suspenders: stop a legacy loop too, in case one is still around.
    if legacy_loop_alive; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
    fi
    pkill -x termcastd 2>/dev/null || true; pkill -x ttyd 2>/dev/null || true
    ;;
  restart)
    shift
    case "$SERVICE_MANAGER" in
      launchd)
        write_launchd_plist "$@"
        launchctl bootout "gui/$(id -u)/com.termcast.daemon" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$PLIST"
        launchctl kickstart -k "gui/$(id -u)/com.termcast.daemon"
        echo "Termcast restarted — logs: $LOG"
        ;;
      systemd)
        write_systemd_unit "$@"
        systemctl --user daemon-reload
        systemctl --user restart termcast
        echo "Termcast restarted — logs: $LOG"
        ;;
      *)
        "$0" stop
        sleep 1
        "$0" start "$@"
        ;;
    esac
    ;;
  logs)
    tail -f "$LOG"
    ;;
  status)
    shift
    # Delegate to the Node CLI, which queries the running server for live
    # details (termcastd process, connected clients, relay usage, uptime).
    exec "$NODE_PATH" "$SCRIPT" status "$@"
    ;;
  connect)
    shift
    # Delegate to the Node CLI: list meshed servers and open one in the browser.
    exec "$NODE_PATH" "$SCRIPT" connect "$@"
    ;;
  *)
    exec "$NODE_PATH" "$SCRIPT" "$@"
    ;;
esac
WRAPPER

  sed -i.bak "s|NODE_PATH_PLACEHOLDER|$NODE_PATH|" "$INSTALL_DIR/bin/termcast"
  sed -i.bak "s|SERVICE_MANAGER_PLACEHOLDER|$SERVICE_MANAGER|" "$INSTALL_DIR/bin/termcast"
  rm -f "$INSTALL_DIR/bin/termcast.bak"
  chmod +x "$INSTALL_DIR/bin/termcast"

  # Mirrors the wrapper's baked-in choice to a plain file so the Node CLI
  # (which can't easily parse the wrapper script) can read it too — see
  # `termcast upgrade`'s supervisor-liveness check.
  echo "$SERVICE_MANAGER" > "$INSTALL_DIR/service-manager"
}

# ── Add to PATH ──────────────────────────────────────────────────
setup_path() {
  local PATH_LINE='export PATH="$HOME/.termcast/bin:$PATH"'
  local ADDED_FILES=""

  add_to_rc() {
    local rc="$1"
    if [ -f "$rc" ] && grep -q '.termcast/bin' "$rc" 2>/dev/null; then
      return
    fi
    printf '\n# termcast\n%s\n' "$PATH_LINE" >> "$rc"
    ADDED_FILES="${ADDED_FILES} ${rc/$HOME/~}"
  }

  # Add to all common shell RC files so it works everywhere
  # bash
  if [ -f "$HOME/.bashrc" ]; then
    add_to_rc "$HOME/.bashrc"
  fi
  if [ -f "$HOME/.bash_profile" ]; then
    add_to_rc "$HOME/.bash_profile"
  fi
  # zsh
  add_to_rc "$HOME/.zshrc"
  # POSIX fallback
  if [ -f "$HOME/.profile" ]; then
    add_to_rc "$HOME/.profile"
  fi
  # fish
  if command -v fish &>/dev/null; then
    local FISH_RC="$HOME/.config/fish/config.fish"
    mkdir -p "$(dirname "$FISH_RC")"
    if ! grep -q '.termcast/bin' "$FISH_RC" 2>/dev/null; then
      printf '\n# termcast\nset -gx PATH $HOME/.termcast/bin $PATH\n' >> "$FISH_RC"
      ADDED_FILES="${ADDED_FILES} ${FISH_RC/$HOME/~}"
    fi
  fi

  if [ -n "$ADDED_FILES" ]; then
    info "Added to PATH in:${ADDED_FILES}"
  fi
}

# ── Main ─────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "  ${BOLD}Termcast${NC} installer"
  echo -e "  ${DIM}Access your terminal from anywhere${NC}"
  echo ""

  detect_platform
  detect_service_manager

  local PLATFORM_LABEL="$PLATFORM-$NODE_ARCH"
  if [ "$IS_WSL" = true ]; then
    PLATFORM_LABEL="$PLATFORM_LABEL (WSL)"
  fi
  info "Platform: $PLATFORM_LABEL"
  info "Service manager: $SERVICE_MANAGER"
  echo ""

  BUNDLED_NODE=false
  TOTAL_STEPS=6

  CURRENT_STEP=1

  # Step 1: Ensure Node.js
  ensure_node

  # Step 2: Download server
  CURRENT_STEP=$((CURRENT_STEP + 1))
  download_server

  # Step 3: Install deps
  CURRENT_STEP=$((CURRENT_STEP + 1))
  install_deps

  # Step 4: Download binary
  CURRENT_STEP=$((CURRENT_STEP + 1))
  download_binary

  # Step 5: Download tmux (optional — falls back to basic shell if unavailable)
  CURRENT_STEP=$((CURRENT_STEP + 1))
  download_tmux

  # Step 6: Create wrapper + PATH
  CURRENT_STEP=$((CURRENT_STEP + 1))
  create_wrapper
  setup_path

  # Add to PATH for the current session
  export PATH="$INSTALL_DIR/bin:$PATH"

  # Done
  echo ""
  echo -e "  ${GREEN}${BOLD}Termcast installed successfully!${NC}"
  echo ""
  echo -e "  Commands:"
  echo -e "    ${CYAN}termcast start${NC}     Start the server (auto-restarts on crash)"
  echo -e "    ${CYAN}termcast stop${NC}      Stop the server"
  echo -e "    ${CYAN}termcast restart${NC}   Restart the server"
  echo -e "    ${CYAN}termcast logs${NC}      Stream server logs"
  echo -e "    ${CYAN}termcast status${NC}    Show server status, clients & relay usage"
  echo -e "    ${CYAN}termcast connect${NC}   Open a meshed server in your browser"
  echo -e "    ${CYAN}termcast qr${NC}        Regenerate QR code"
  echo ""
  if [ "$IS_WSL" = true ]; then
    echo -e "  ${DIM}Tip: In WSL, scan the QR code from the terminal or open${NC}"
    echo -e "  ${DIM}http://localhost:8080 in your Windows browser.${NC}"
    echo ""
  fi
  echo -e "  ${YELLOW}To activate in this terminal, run:${NC}"
  echo ""
  echo -e "    ${CYAN}source ~/.bashrc${NC}    ${DIM}# or: source ~/.zshrc${NC}"
  echo ""
  echo -e "  ${DIM}Then run 'termcast start' to get started.${NC}"
  echo ""
}

main
