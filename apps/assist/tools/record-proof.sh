#!/bin/sh
# Records the Phase 1 proof against Blender: bubble opens and closes, Buddy points at Bevel and
# fades, then a "stay" ask keeps Buddy up until the next summon dismisses it.
#   tools/record-proof.sh [out.mov]
# Blender should be open (Edit Mode shows the Bevel and Loop Cut tools in the toolbar).
set -e
cd "$(dirname "$0")/.."
OUT="${1:-proof/relay-buddy-phase1.mov}"
B=build/RelayBuddy.app/Contents/MacOS/RelayBuddy
[ -x build/proofrec ] || swiftc -O -swift-version 5 -o build/proofrec tools/proofrec.swift
BLENDER_PID="$(pgrep -x Blender | head -1)"
[ -n "$BLENDER_PID" ] || { echo "Blender is not running" >&2; exit 1; }

: > "$HOME/Library/Logs/RelayBuddy.log"
nohup "$B" >/dev/null 2>&1 &
BUDDY_PID=$!
sleep 1.5
nohup build/proofrec "$OUT" 30 "$BLENDER_PID" "$BUDDY_PID" > /tmp/relay-buddy-proofrec.log 2>&1 &
REC_PID=$!
sleep 1.5
"$B" --summon; sleep 3
"$B" --summon; sleep 1
"$B" --send "where is the bevel tool?" --target Blender; sleep 9
"$B" --send "where is the loop cut tool? stay" --target Blender; sleep 11
"$B" --summon; sleep 1.5
"$B" --summon
wait $REC_PID || true
cat /tmp/relay-buddy-proofrec.log "$HOME/Library/Logs/RelayBuddy.log"
