#!/usr/bin/env bash
# Test log rotation for the termcast-loop supervisor shipped by install.sh.
#
# Verifies (a) the active log is rotated once it passes the threshold, and
# (b) the total on-disk footprint (termcast.log + termcast.log.1) stays
# within the ~5MB budget even after a large burst of output.
#
#   Run:  docker run --rm --init \
#           -v "$PWD/scripts:/scripts" debian:bookworm-slim \
#           bash -c 'apt-get update -qq && apt-get install -y -qq procps && \
#                    bash /scripts/termcast-logrotate.test.sh'
set -u

# Default to install.sh sitting next to this test. Under the documented
# `docker run -v "$PWD/scripts:/scripts"` invocation this resolves to
# /scripts/install.sh exactly as before; it also works from a plain checkout.
_TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="${INSTALL_SH:-$_TEST_DIR/install.sh}"
export HOME="${HOME:-/root}"
BUDGET=5242880       # 5 MB total budget
PERFILE=2621440      # 2.5 MB per-file cap (MAX_LOG in install.sh)
mkdir -p "$HOME/.termcast/bin" "$HOME/.termcast/dist"

LOG="$HOME/.termcast/termcast.log"
PID_FILE="$HOME/.termcast/termcast.pid"
fail() { echo "FAIL: $*"; kill -9 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null || true; exit 1; }

# Fake "node": a long-running server (stands in for `node dist/index.js start`).
cat > "$HOME/.termcast/node" <<'NODE'
#!/usr/bin/env bash
echo "up $$"
exec sleep 300
NODE
chmod +x "$HOME/.termcast/node"
touch "$HOME/.termcast/dist/index.js"

awk "/<< 'LOOP'/{f=1;next} /^LOOP\$/{if(f){exit}} f" "$INSTALL_SH" \
  > "$HOME/.termcast/bin/termcast-loop"
sed -i "s|NODE_PATH_PLACEHOLDER|$HOME/.termcast/node|" "$HOME/.termcast/bin/termcast-loop"
chmod +x "$HOME/.termcast/bin/termcast-loop"

start_supervisor() {
  TERMCAST_ROTATE_INTERVAL=1 setsid nohup "$HOME/.termcast/bin/termcast-loop" \
    > /dev/null 2>&1 &
  sleep 3
}
stop_supervisor() { kill -9 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null || true; sleep 1; }
sizeof() { [ -f "$1" ] && wc -c < "$1" || echo 0; }

# ── Scenario 1: a log over the threshold gets rotated (copytruncate) ──
rm -f "$LOG" "$LOG.1"
head -c 3145728 /dev/zero | tr '\0' 'x' > "$LOG"   # 3 MB (> 2.5 MB threshold)
start_supervisor
active=$(sizeof "$LOG"); backup=$(sizeof "$LOG.1")
echo "scenario1: active=$active backup=$backup"
[ -f "$LOG.1" ] || fail "rotation did not create termcast.log.1"
[ "$active" -lt "$PERFILE" ] || fail "active log was not truncated after rotation"
stop_supervisor
echo "ok: log rotated once it passed the 2.5MB threshold"

# ── Scenario 2: a huge burst still respects the ~5MB total budget ──
rm -f "$LOG" "$LOG.1"
head -c 10485760 /dev/zero | tr '\0' 'x' > "$LOG"  # 10 MB burst between checks
start_supervisor
active=$(sizeof "$LOG"); backup=$(sizeof "$LOG.1"); total=$((active + backup))
echo "scenario2: active=$active backup=$backup total=$total budget=$BUDGET"
[ "$backup" -le "$PERFILE" ] || fail "backup $backup exceeds per-file cap $PERFILE"
[ "$total" -le "$BUDGET" ] || fail "total $total exceeds 5MB budget $BUDGET"
stop_supervisor
echo "ok: 10MB burst rotated down to within the 5MB budget"

echo "PASS: log rotation caps total footprint at ~5MB"
