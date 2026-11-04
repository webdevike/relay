#!/bin/sh
# 30 s capture proof: starts the helper in the background (open -g, no activation), plays the spoken
# test file once the helper reports "recording", and prints the helper's summary.
#   sh run-proof.sh <out dir> <sound file> [extra helper args...]
set -e
cd "$(dirname "$0")"
OUT="$1"; SOUND="$2"; shift 2
APP="$PWD/build/Relay Meetings.app"
rm -rf "$OUT"; mkdir -p "$OUT"
front() { osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'; }
echo "frontmost before: $(front)"
open -g -n --stdout "$OUT/helper.out" --stderr "$OUT/helper.err" "$APP" --args record --seconds 34 --out "$OUT" "$@"
i=0
until grep -q '"recording"' "$OUT/helper.out" 2>/dev/null; do
	i=$((i + 1)); [ $i -gt 600 ] && { echo "helper never started recording"; cat "$OUT/helper.out"; exit 1; }
	sleep 0.1
done
sleep 1
afplay "$SOUND"
until grep -q '"meeting.end"' "$OUT/helper.out" 2>/dev/null; do sleep 0.5; done
echo "frontmost after: $(front)"
cat "$OUT/helper.out"
