#!/bin/sh
# termcast agent session hook. Records which Claude Code sessions are live so
# the phone can show a live badge and target the right multiplexer pane.
#
# Registered for both SessionStart and SessionEnd; the event name decides which.
set -u

DIR="$HOME/.ttyd-server/agent-sessions"
INPUT="$(cat)"
[ -n "$INPUT" ] || exit 0

field() {
  printf '%s' "$INPUT" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
}

SESSION_ID="$(field session_id)"
[ -n "$SESSION_ID" ] || exit 0

EVENT="$(field hook_event_name)"

if [ "$EVENT" = "SessionEnd" ]; then
  rm -f "$DIR/$SESSION_ID.json" 2>/dev/null
  exit 0
fi

mkdir -p "$DIR" 2>/dev/null || exit 0
TMP="$DIR/$SESSION_ID.json.tmp"
printf '{"sessionId":"%s","cwd":"%s","transcriptPath":"%s","pid":%s,"paneId":%s}\n' \
  "$SESSION_ID" "$(field cwd)" "$(field transcript_path)" "$PPID" \
  "$([ -n "${TMUX_PANE:-}" ] && printf '"%s"' "$TMUX_PANE" || printf 'null')" \
  > "$TMP" 2>/dev/null || exit 0
mv "$TMP" "$DIR/$SESSION_ID.json" 2>/dev/null

exit 0
