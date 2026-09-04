#!/usr/bin/env bash
# Tests that the generated `termcast` wrapper dispatches to the right
# launchctl/systemctl/loginctl calls for each SERVICE_MANAGER, using fake
# shims on PATH instead of a real launchd/systemd (neither is available in
# a plain container, and launchd doesn't exist on Linux at all).
#
#   Run:  bash scripts/termcast-wrapper.test.sh
set -u

_TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="${INSTALL_SH:-$_TEST_DIR/install.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*"; exit 1; }

# Extract the termcast wrapper heredoc body from install.sh, the same way
# termcast-loop.test.sh extracts termcast-loop.
extract_wrapper() {
  awk "/<< 'WRAPPER'\$/{f=1;next} /^WRAPPER\$/{if(f){exit}} f" "$INSTALL_SH"
}

setup_home() {
  local home="$1" service_manager="$2"
  mkdir -p "$home/.termcast/bin" "$home/bin"
  extract_wrapper > "$home/.termcast/bin/termcast"
  sed -i.bak "s|NODE_PATH_PLACEHOLDER|/usr/bin/env node|" "$home/.termcast/bin/termcast"
  sed -i.bak "s|SERVICE_MANAGER_PLACEHOLDER|$service_manager|" "$home/.termcast/bin/termcast"
  rm -f "$home/.termcast/bin/termcast.bak"
  chmod +x "$home/.termcast/bin/termcast"
}

# A shim that appends its own name + args to a shared log, then exits 0.
write_shim() {
  local bin_dir="$1" name="$2" calls_file="$3"
  cat > "$bin_dir/$name" <<SHIM
#!/usr/bin/env bash
echo "$name \$*" >> "$calls_file"
exit 0
SHIM
  chmod +x "$bin_dir/$name"
}

[ -f "$INSTALL_SH" ] || fail "install.sh not found at $INSTALL_SH"
extract_wrapper | grep -q 'SERVICE_MANAGER_PLACEHOLDER' \
  || fail "could not extract the termcast wrapper from $INSTALL_SH"

# ── Scenario 1: launchd — start bootouts/bootstraps/kickstarts, stop kills ──
HOME1="$WORK/launchd-home"
CALLS1="$WORK/launchd-calls"
: > "$CALLS1"
setup_home "$HOME1" "launchd"
write_shim "$HOME1/bin" launchctl "$CALLS1"
PATH="$HOME1/bin:$PATH" HOME="$HOME1" "$HOME1/.termcast/bin/termcast" start >/dev/null
grep -q '^launchctl bootout gui/' "$CALLS1" || fail "launchd start did not bootout the old registration"
grep -q '^launchctl bootstrap gui/' "$CALLS1" || fail "launchd start did not bootstrap"
grep -q '^launchctl kickstart -k gui/.*com.termcast.daemon$' "$CALLS1" || fail "launchd start did not kickstart"
[ -f "$HOME1/Library/LaunchAgents/com.termcast.daemon.plist" ] || fail "plist was not written"
grep -q '<key>RunAtLoad</key><false/>' "$HOME1/Library/LaunchAgents/com.termcast.daemon.plist" || fail "plist RunAtLoad is not false"
grep -q '<key>SuccessfulExit</key><false/>' "$HOME1/Library/LaunchAgents/com.termcast.daemon.plist" || fail "plist KeepAlive.SuccessfulExit is not false"
echo "ok: launchd start bootouts, bootstraps, kickstarts; plist has no autostart and KeepAlive-on-failure"

: > "$CALLS1"
PATH="$HOME1/bin:$PATH" HOME="$HOME1" "$HOME1/.termcast/bin/termcast" stop >/dev/null
grep -q '^launchctl kill SIGTERM gui/.*com.termcast.daemon$' "$CALLS1" || fail "launchd stop did not send SIGTERM via launchctl kill"
echo "ok: launchd stop sends SIGTERM via launchctl kill"

# Start with extra flags — must appear in the regenerated plist's ProgramArguments.
: > "$CALLS1"
PATH="$HOME1/bin:$PATH" HOME="$HOME1" "$HOME1/.termcast/bin/termcast" start -p 9000 >/dev/null
grep -q '<string>-p</string>' "$HOME1/Library/LaunchAgents/com.termcast.daemon.plist" || fail "plist did not bake in the -p flag"
grep -q '<string>9000</string>' "$HOME1/Library/LaunchAgents/com.termcast.daemon.plist" || fail "plist did not bake in the 9000 arg"
echo "ok: launchd start re-bakes current flags into the plist"

# Regression: `restart` must also stop a live legacy termcast-loop first, not
# just `start` — otherwise `termcast upgrade` regenerating the wrapper on an
# already-running pre-migration install and then auto-restarting would leave
# the old loop running AND start a second, natively-supervised daemon.
sleep 300 & LEGACY_PID1=$!
echo "$LEGACY_PID1" > "$HOME1/.termcast/termcast.pid"
: > "$CALLS1"
PATH="$HOME1/bin:$PATH" HOME="$HOME1" "$HOME1/.termcast/bin/termcast" restart >/dev/null
sleep 1
kill -0 "$LEGACY_PID1" 2>/dev/null && fail "launchd restart left the legacy loop process running"
[ -f "$HOME1/.termcast/termcast.pid" ] && fail "launchd restart left the legacy loop's PID file behind"
grep -q '^launchctl kickstart -k gui/.*com.termcast.daemon$' "$CALLS1" || fail "launchd restart did not still kickstart after stopping the legacy loop"
echo "ok: launchd restart stops a live legacy loop before taking over"

# ── Scenario 2: systemd — start reloads/enables linger/restarts, stop stops ──
HOME2="$WORK/systemd-home"
CALLS2="$WORK/systemd-calls"
: > "$CALLS2"
setup_home "$HOME2" "systemd"
write_shim "$HOME2/bin" systemctl "$CALLS2"
write_shim "$HOME2/bin" loginctl "$CALLS2"
PATH="$HOME2/bin:$PATH" HOME="$HOME2" "$HOME2/.termcast/bin/termcast" start >/dev/null
grep -q '^systemctl --user daemon-reload$' "$CALLS2" || fail "systemd start did not daemon-reload"
grep -q '^loginctl enable-linger ' "$CALLS2" || fail "systemd start did not enable linger"
grep -q '^systemctl --user restart termcast$' "$CALLS2" || fail "systemd start did not restart the unit"
[ -f "$HOME2/.config/systemd/user/termcast.service" ] || fail "unit file was not written"
grep -q '^Restart=on-failure$' "$HOME2/.config/systemd/user/termcast.service" || fail "unit is missing Restart=on-failure"
grep -q '^\[Install\]$' "$HOME2/.config/systemd/user/termcast.service" && fail "unit has an [Install] section — that would imply boot/login autostart"
echo "ok: systemd start reloads, enables linger, restarts; unit restarts on failure with no [Install] (no autostart)"

: > "$CALLS2"
PATH="$HOME2/bin:$PATH" HOME="$HOME2" "$HOME2/.termcast/bin/termcast" stop >/dev/null
grep -q '^systemctl --user stop termcast$' "$CALLS2" || fail "systemd stop did not stop the unit"
echo "ok: systemd stop calls systemctl --user stop"

# Same regression as the launchd case above, for the systemd path.
sleep 300 & LEGACY_PID2=$!
echo "$LEGACY_PID2" > "$HOME2/.termcast/termcast.pid"
: > "$CALLS2"
PATH="$HOME2/bin:$PATH" HOME="$HOME2" "$HOME2/.termcast/bin/termcast" restart >/dev/null
sleep 1
kill -0 "$LEGACY_PID2" 2>/dev/null && fail "systemd restart left the legacy loop process running"
[ -f "$HOME2/.termcast/termcast.pid" ] && fail "systemd restart left the legacy loop's PID file behind"
grep -q '^systemctl --user restart termcast$' "$CALLS2" || fail "systemd restart did not still restart the unit after stopping the legacy loop"
echo "ok: systemd restart stops a live legacy loop before taking over"

# ── Scenario 3: loop fallback still works when SERVICE_MANAGER=loop ──
HOME3="$WORK/loop-home"
setup_home "$HOME3" "loop"
mkdir -p "$HOME3/.termcast/dist"
cat > "$HOME3/.termcast/bin/fakenode" <<'NODE'
#!/usr/bin/env bash
echo "up $$"
exec sleep 300
NODE
chmod +x "$HOME3/.termcast/bin/fakenode"
sed -i.bak "s|^NODE_PATH=.*|NODE_PATH=\"$HOME3/.termcast/bin/fakenode\"|" "$HOME3/.termcast/bin/termcast"
rm -f "$HOME3/.termcast/bin/termcast.bak"
sed -i.bak "s|^SCRIPT=.*|SCRIPT=\"\"|" "$HOME3/.termcast/bin/termcast"
rm -f "$HOME3/.termcast/bin/termcast.bak"
awk "/<< 'LOOP'\$/{f=1;next} /^LOOP\$/{if(f){exit}} f" "$INSTALL_SH" > "$HOME3/.termcast/bin/termcast-loop"
sed -i.bak "s|NODE_PATH_PLACEHOLDER|$HOME3/.termcast/bin/fakenode|" "$HOME3/.termcast/bin/termcast-loop"
rm -f "$HOME3/.termcast/bin/termcast-loop.bak"
chmod +x "$HOME3/.termcast/bin/termcast-loop"
HOME="$HOME3" "$HOME3/.termcast/bin/termcast" start >/dev/null
sleep 1
[ -f "$HOME3/.termcast/termcast.pid" ] || fail "loop fallback did not start (no PID file)"
kill -0 "$(cat "$HOME3/.termcast/termcast.pid")" 2>/dev/null || fail "loop fallback PID is not alive"
echo "ok: SERVICE_MANAGER=loop still starts the fallback supervisor"
HOME="$HOME3" "$HOME3/.termcast/bin/termcast" stop >/dev/null
sleep 1
[ -f "$HOME3/.termcast/termcast.pid" ] && fail "loop fallback PID file survived stop"
echo "ok: SERVICE_MANAGER=loop stop cleans up"

echo "PASS: wrapper dispatches correctly for launchd, systemd, and the loop fallback"
