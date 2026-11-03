#!/bin/sh
# Records the assistant-cursor proof: one hotkey, the answer routed to Nova or Astra.
#   tools/record-assistant.sh   -> proof/assistant-cursor.mp4 (1280x720, captioned per scene)
# 1 Blender         "where is the bevel tool"  -> Nova (default) points at Bevel
# 2 Finder          "open ENG-6309"            -> Astra (issue key) opens Linear by shortcut, points at the title
# 3 Linear          "what is this ticket?"     -> Astra (Linear in front) explains it
# 4 System Settings "Nova, where is Wi-Fi"     -> Nova (named) points at Wi-Fi
# Each ask goes through the real hotkey (Control+Option+Space tap) and the prompt bubble. Needs
# Blender (MCP add-on), Linear, Finder and System Settings running with windows on the main display.
set -e
cd "$(dirname "$0")/.."
B=build/RelayBuddy.app/Contents/MacOS/RelayBuddy
L="$HOME/Library/Logs/RelayBuddy.log"
[ -x build/proofrec ] || swiftc -O -swift-version 5 -o build/proofrec tools/proofrec.swift

pid() { pgrep -x "$1" | head -1; }
mouse() { python3 -c "import Quartz; Quartz.CGWarpMouseCursorPosition(($1, $2))"; }
front() { osascript -e "tell application \"$1\" to activate"; sleep 0.8; }
wait_for() {
	i=0
	while [ $i -lt 60 ]; do grep -q "$1" "$L" && return 0; sleep 0.25; i=$((i + 1)); done
	echo "timed out waiting for: $1" >&2
	return 1
}
linear_title() {
	python3 -c "
import Quartz
for w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID):
    if w['kCGWindowOwnerName'] == 'Linear' and w.get('kCGWindowLayer') == 0: print(w.get('kCGWindowName', '')); break"
}
# The hotkey, then the question typed into the bubble. Typing only once the bubble is up, so no
# keystroke ever lands in the app itself.
ask() {
	before=$(wc -l < "$L")
	osascript -e 'tell application "System Events" to key code 49 using {control down, option down}'
	i=0
	until tail -n +"$((before + 1))" "$L" | grep -q "summon: target="; do
		i=$((i + 1)); [ $i -lt 20 ] || { echo "bubble did not open" >&2; exit 1; }; sleep 0.1
	done
	sleep 0.6
	osascript -e "tell application \"System Events\" to keystroke \"$1\""
	sleep 0.7
	osascript -e 'tell application "System Events" to key code 36'
}
# scene <name> <seconds> <pid...>: records in the background; REC holds the recorder's pid. The
# log restarts per scene (earlier scenes are kept in build/assist-run.log), so waits see only this one.
scene() {
	name="$1"; secs="$2"; shift 2
	cat "$L" >> build/assist-run.log; : > "$L"
	nohup build/proofrec "build/assist-$name.mov" "$secs" "$@" "$BUDDY_PID" > "/tmp/assist-$name.log" 2>&1 &
	REC=$!
	sleep 1.2
}

pkill -f 'RelayBuddy.app/Contents/MacOS/RelayBuddy' || true
sleep 0.5
: > "$L"; : > build/assist-run.log
RELAY_BUDDY_SPEAK=0 nohup "$B" >/dev/null 2>&1 &
BUDDY_PID=$!
sleep 2.5

# 1 Blender, Nova
tools/blender.py --reset >/dev/null
front Blender; mouse 900 620
scene 1-blender 17 "$(pid Blender)"
ask "where is the bevel tool"
wait_for "ask->point" || true
wait $REC || true

# 2 Finder -> Linear by shortcut, Astra
open "linear://ecard-systems/inbox"; sleep 1.5
linear_title | grep -q Inbox || { echo "Linear did not leave ENG-6309" >&2; exit 1; }
front Finder; mouse 1950 420
scene 2-finder 14 "$(pid Finder)" "$(pid Linear)"
ask "open ENG-6309"
wait_for "kind=linear key=ENG-6309 point=" || true
wait $REC || true

# 3 Linear, Astra explains
front Linear; mouse 2250 330
scene 3-linear 15 "$(pid Linear)"
ask "what is this ticket?"
wait_for "plan in" || true
wait $REC || true

# 4 System Settings, Nova by name
front "System Settings"; mouse 1560 520
scene 4-settings 11 "$(pid "System Settings")"
ask "Nova, where is Wi-Fi"
wait_for "route: path=jev" || true
wait $REC || true

cat "$L" >> build/assist-run.log
# Neutral again: Blender scene reset, Linear on the inbox, the assistant back with its voice.
tools/blender.py --reset >/dev/null
open "linear://ecard-systems/inbox"
kill "$BUDDY_PID" 2>/dev/null || true
sleep 0.5
open -n build/RelayBuddy.app

python3 tools/assist-cut.py
echo "saved proof/assistant-cursor.mp4"
