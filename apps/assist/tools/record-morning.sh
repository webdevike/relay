#!/bin/sh
# Records the morning demo's raw scenes (build/morning-*.mov, full main display, with the assistants'
# voices); tools/morning-cut.py cuts them into proof/morning-demo.mp4 and the stills.
# 1 Blender "where is the bevel tool"                      Nova, outline on Bevel + trail
# 2 Blender "teach me to start a donut: ..."               lesson; each step done here via tools/blender.py
# 3 Finder  "open ENG-6309"                                Astra, Linear opens by shortcut
# 4 Linear  "what is this ticket?"                         Astra explains it, spoken
# 5 Linear  "TEST: hand this off"                          TEST handoff to Astra's thread, confirmation
# 6 Linear  "what can you do here?"                        the capabilities template
# Every ask goes through the hotkey and the input-only bubble. Idle-gated: starts only after 120 s with
# no input, and stops (restoring everything) if a person touches the Mac between scenes.
set -e
cd "$(dirname "$0")/.."
B=build/RelayBuddy.app/Contents/MacOS/RelayBuddy
L="$HOME/Library/Logs/RelayBuddy.log"
[ build/proofrec -nt tools/proofrec.swift ] || swiftc -O -swift-version 5 -o build/proofrec tools/proofrec.swift

idle() { ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1e9); exit}'; }
# Our own keystrokes reset the idle clock too: a person was here only if the Mac has been idle for
# less time than has passed since our last injected event.
LAST=$(date +%s)
injected() { LAST=$(date +%s); }
# Whatever happens (done, a failed wait, someone at the Mac): stop the lesson, default scene, Blender
# full width, Linear on the inbox, Relay Assist running again with her voice.
restore() {
	"$B" --send stop --target Blender 2>/dev/null || true
	sleep 0.5
	tools/blender.py --reset >/dev/null 2>&1 || true
	osascript -e 'tell application "System Events" to tell process "Blender" to set size of window 1 to {3840, 1050}' >/dev/null 2>&1 || true
	open "linear://ecard-systems/inbox"
	pkill -f 'RelayBuddy.app/Contents/MacOS/RelayBuddy' || true
	sleep 0.5
	open -n build/RelayBuddy.app
}
guard() {
	since=$(( $(date +%s) - LAST ))
	now=$(idle)
	if [ "$now" -lt 5 ] && [ "$since" -gt 6 ]; then
		echo "someone is using the Mac (idle ${now}s, our last input ${since}s ago): stopping" >&2
		exit 3
	fi
}
[ "$(idle)" -ge 120 ] || { echo "not idle for 120 s ($(idle) s): not recording" >&2; exit 3; }
trap restore EXIT

pid() { pgrep -x "$1" | head -1; }
mouse() { python3 -c "import Quartz; Quartz.CGWarpMouseCursorPosition(($1, $2))"; injected; }
front() { osascript -e "tell application \"$1\" to activate"; sleep 0.8; }
wait_for() {
	i=0
	while [ $i -lt 80 ]; do grep -q "$1" "$L" && return 0; sleep 0.25; i=$((i + 1)); done
	echo "timed out waiting for: $1" >&2
	return 1
}
ask() {
	before=$(wc -l < "$L")
	osascript -e 'tell application "System Events" to key code 49 using {control down, option down}'
	injected
	i=0
	until tail -n +"$((before + 1))" "$L" | grep -q "summon: target="; do
		i=$((i + 1)); [ $i -lt 20 ] || { echo "bubble did not open" >&2; exit 1; }; sleep 0.1
	done
	sleep 0.9
	osascript -e "tell application \"System Events\" to keystroke \"$1\""
	sleep 0.8
	osascript -e 'tell application "System Events" to key code 36'
	injected
}
scene() {
	guard
	name="$1"; secs="$2"; shift 2
	cat "$L" >> build/morning-run.log; : > "$L"
	PROOFREC_AUDIO=1 nohup build/proofrec "build/morning-$name.mov" "$secs" "$@" "$BUDDY_PID" > "/tmp/morning-$name.log" 2>&1 &
	REC=$!
	sleep 1.2
}

pkill -f 'RelayBuddy.app/Contents/MacOS/RelayBuddy' || true
sleep 0.5
: > "$L"; : > build/morning-run.log
nohup "$B" >/dev/null 2>&1 &
BUDDY_PID=$!
sleep 2.5

# Blender at half the display, so the lesson checklist sits beside it in the frame.
tools/blender.py --reset >/dev/null
osascript -e 'tell application "System Events" to tell process "Blender" to set size of window 1 to {1920, 1050}' \
	-e 'tell application "System Events" to tell process "Blender" to set position of window 1 to {0, 30}'
front Blender; mouse 900 620

# ONLY="4 6" re-records just those scenes (the others' .mov files are kept).
want() { [ -z "$ONLY" ] || case " $ONLY " in *" $1 "*) true ;; *) false ;; esac; }

if want 1; then # Blender, where is the bevel tool
	scene 1-bevel 16 "$(pid Blender)"
	ask "where is the bevel tool"
	wait_for "ask->point" || true
	wait $REC || true
fi

if want 2; then # Blender lesson
	tools/blender.py --reset >/dev/null
	front Blender; mouse 900 620
	scene 2-lesson 46 "$(pid Blender)"
	ask "teach me to start a donut: add a torus, scale it up, shade it smooth"
	# Each step is done once she has said it, so her instruction is heard to the end.
	wait_for "lesson point step 1"; sleep 5.5
	tools/blender.py 'with ctx(): bpy.ops.mesh.primitive_torus_add(location=(0, 0, 1.6))' >/dev/null
	wait_for "lesson point step 2"; sleep 5.5
	tools/blender.py 'bpy.context.view_layer.objects.active.scale = (2.2, 2.2, 2.2)' >/dev/null
	wait_for "lesson point step 3"; sleep 5.5
	tools/blender.py 'with ctx(): bpy.ops.object.shade_smooth()' >/dev/null
	wait_for "lesson end" || true
	wait $REC || true
	tools/blender.py --reset >/dev/null
fi

if want 3; then # Finder -> Linear by shortcut
	open "linear://ecard-systems/inbox"; sleep 1.5
	osascript -e 'tell application "Finder" to set bounds of front window to {1990, 240, 2990, 700}' || true
	front Finder; mouse 2400 470
	scene 3-open 11 "$(pid Finder)" "$(pid Linear)"
	ask "open ENG-6309"
	wait_for "kind=linear key=ENG-6309 point=" || true
	wait $REC || true
fi

# 4 to 6 happen in Linear on ENG-6309.
if want 4 || want 5 || want 6; then
	want 3 || { open "linear://ecard-systems/issue/ENG-6309"; sleep 2; }
	front Linear; mouse 2250 330
fi

if want 4; then # Linear explains the ticket
	scene 4-explain 26 "$(pid Linear)"
	ask "what is this ticket?"
	wait_for "plan in" || true
	wait $REC || true
fi

if want 5; then # TEST handoff
	scene 5-handoff 9 "$(pid Linear)"
	ask "TEST: hand this off"
	wait_for "path=handoff" || true
	wait $REC || true
fi

if want 6; then # What can you do here?
	scene 6-help 14 "$(pid Linear)"
	ask "what can you do here?"
	wait_for "path=capabilities" || true
	wait $REC || true
fi

cat "$L" >> build/morning-run.log
echo "recorded build/morning-*.mov; cut with: python3 tools/morning-cut.py"
