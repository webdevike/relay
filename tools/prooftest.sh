#!/bin/sh
# Scripted end-to-end run: start Relay Buddy, record the target app + Buddy windows, ask a question.
#   tools/prooftest.sh "where is the bevel tool?" Blender proof/blender-bevel.mov [seconds]
# Run from a session that holds Screen Recording (and Accessibility for the AX tree).
set -e
cd "$(dirname "$0")/.."
QUESTION="$1"; TARGET="$2"; OUT="$3"; SECONDS_TO_RECORD="${4:-16}"
APP_BIN=build/RelayBuddy.app/Contents/MacOS/RelayBuddy
[ -x build/proofrec ] || swiftc -O -swift-version 5 -o build/proofrec tools/proofrec.swift

TARGET_PID="$(osascript -e "tell application \"System Events\" to get unix id of first process whose name is \"$TARGET\"" 2>/dev/null || pgrep -x "$TARGET" | head -1)"
[ -n "$TARGET_PID" ] || { echo "no running app named $TARGET" >&2; exit 1; }

LOG="$HOME/Library/Logs/RelayBuddy.log"
: > "$LOG"
nohup "$APP_BIN" >/dev/null 2>&1 &
BUDDY_PID=$!
sleep 1.5
nohup build/proofrec "$OUT" "$SECONDS_TO_RECORD" "$TARGET_PID" "$BUDDY_PID" > /tmp/relay-buddy-proofrec.log 2>&1 &
REC_PID=$!
sleep 1.5
"$APP_BIN" --send "$QUESTION" --target "$TARGET"
wait $REC_PID || true
cat /tmp/relay-buddy-proofrec.log
cat "$LOG"
