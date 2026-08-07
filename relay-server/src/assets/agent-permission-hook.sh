#!/bin/sh
# termcast agent permission hook.
#
# Asks termcastd whether an attached phone wants to approve this tool call.
# Every failure path exits 0 with no decision, which makes Claude Code fall
# back to its normal terminal prompt. This script must never print an "allow"
# decision on its own.
set -u

PORT_FILE="$HOME/.ttyd-server/web-port"
[ -r "$PORT_FILE" ] || exit 0
PORT="$(cat "$PORT_FILE" 2>/dev/null)" || exit 0
[ -n "$PORT" ] || exit 0

INPUT="$(cat)"
[ -n "$INPUT" ] || exit 0

# termcastd replies immediately with no body when no phone is attached to this
# session, so desktop-only work pays one loopback round-trip and nothing more.
RESPONSE="$(
  printf '%s' "$INPUT" \
  | curl -s --max-time 550 \
         -H 'content-type: application/json' \
         --data-binary @- \
         "http://127.0.0.1:$PORT/api/agent/permission" 2>/dev/null
)" || exit 0

[ -n "$RESPONSE" ] || exit 0

case "$RESPONSE" in
  *'"behavior":"allow"'*|*'"behavior": "allow"'*)
    printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
    ;;
  *'"behavior":"deny"'*|*'"behavior": "deny"'*)
    printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}\n'
    ;;
  *)
    # Unanswered, unreachable, or anything unexpected: no decision.
    ;;
esac

exit 0
