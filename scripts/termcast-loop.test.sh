#!/usr/bin/env bash
# Test for the termcast-loop supervisor shipped by install.sh.
#
# Runs on Linux (designed to be executed inside a container so stray
# processes never touch the host). It extracts the REAL termcast-loop
# heredoc from install.sh and exercises the crash path.
#
#   Run:  docker run --rm --init \
#           -v "$PWD/scripts:/scripts" bash bash /scripts/termcast-loop.test.sh
#
# Requires: procps (pgrep/ps), an init reaper (docker --init) so a
# SIGKILLed supervisor is reaped promptly rather than lingering as a zombie.
set -u

# Default to install.sh sitting next to this test. Under the documented
# `docker run -v "$PWD/scripts:/scripts"` invocation this resolves to
# /scripts/install.sh exactly as before; it also works from a plain checkout.
_TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="${INSTALL_SH:-$_TEST_DIR/install.sh}"
export HOME="${HOME:-/root}"
mkdir -p "$HOME/.termcast/bin" "$HOME/.termcast/dist"

fail() { echo "FAIL: $*"; ps -eo pid,ppid,cmd | grep '[b]in/termcast-loop' || true; exit 1; }

# Fake "node": a long-running server that ignores its args (stands in for
# `node dist/index.js start`).
cat > "$HOME/.termcast/node" <<'NODE'
#!/usr/bin/env bash
echo "server up $$"
exec sleep 300
NODE
chmod +x "$HOME/.termcast/node"
touch "$HOME/.termcast/dist/index.js"

# Extract the termcast-loop script body from install.sh (between the
# `<< 'LOOP'` opener and the closing `LOOP` delimiter) and wire it to the
# fake node.
awk "/<< 'LOOP'/{f=1;next} /^LOOP\$/{if(f){exit}} f" "$INSTALL_SH" \
  > "$HOME/.termcast/bin/termcast-loop"
sed -i "s|NODE_PATH_PLACEHOLDER|$HOME/.termcast/node|" "$HOME/.termcast/bin/termcast-loop"
chmod +x "$HOME/.termcast/bin/termcast-loop"

if [ ! -s "$HOME/.termcast/bin/termcast-loop" ]; then
  fail "could not extract termcast-loop from $INSTALL_SH"
fi

PID_FILE="$HOME/.termcast/termcast.pid"

# Launch the supervisor detached, reparented to init (like `nohup … &`).
setsid nohup "$HOME/.termcast/bin/termcast-loop" \
  > /dev/null 2>&1 &
sleep 2

before=$(pgrep -fc 'bin/termcast-loop'); before=${before:-0}
[ "$before" -ge 1 ] || fail "supervisor did not start (found $before loop procs)"
echo "running loop procs before kill: $before"

# Simulate a hard death of the supervisor with NO chance to run its trap:
# SIGKILL / OOM-kill / panic. Nothing it spawned should survive it either.
sup=$(cat "$PID_FILE" 2>/dev/null || echo "")
[ -n "$sup" ] || fail "no PID file written"
echo "hard-killing supervisor $sup (SIGKILL, trap bypassed)"
kill -9 "$sup"
sleep 4

after=$(pgrep -fc 'bin/termcast-loop'); after=${after:-0}
echo "running loop procs after kill: $after"
if [ "$after" -ne 0 ]; then
  fail "$after orphaned termcast-loop process(es) survived the supervisor"
fi

echo "ok: hard-kill (SIGKILL) leaves no orphan"

# ── Scenario 2: clean stop (SIGTERM) still reaps everything via the trap ──
setsid nohup "$HOME/.termcast/bin/termcast-loop" \
  > /dev/null 2>&1 &
sleep 2
sup=$(cat "$PID_FILE" 2>/dev/null || echo "")
[ -n "$sup" ] || fail "no PID file written (scenario 2)"
echo "stopping supervisor $sup (SIGTERM, like 'termcast stop')"
kill -TERM "$sup"
sleep 2
after=$(pgrep -fc 'bin/termcast-loop'); after=${after:-0}
[ "$after" -eq 0 ] || fail "$after termcast-loop process(es) survived a clean stop"
[ -f "$PID_FILE" ] && fail "PID file not removed on clean stop"
echo "ok: clean stop (SIGTERM) leaves no orphan and removes PID file"

echo "PASS: no orphaned termcast-loop processes after supervisor died"
