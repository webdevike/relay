#!/bin/sh
# Records a Phase 2 proof against Blender and cuts a phone-friendly 1280x720 clip.
#   tools/record-phase2.sh chore|doit|lesson
# chore:  "how do I bevel?" in Object Mode: Buddy switches to Edit Mode for you, then points at Bevel.
# doit:   "bevel it for me": Buddy bevels the cube, shows Undo, and the Undo pill is pressed.
# lesson: "teach me to start a donut: ...": three steps, each done here through the Blender
#         add-on (standing in for the user) and detected by Buddy's completion checks.
# Blender must be running with the MCP for Blender add-on; the scene is reset before and after.
set -e
cd "$(dirname "$0")/.."
SCENARIO="$1"
B=build/RelayBuddy.app/Contents/MacOS/RelayBuddy
L="$HOME/Library/Logs/RelayBuddy.log"
[ -x build/proofrec ] || swiftc -O -swift-version 5 -o build/proofrec tools/proofrec.swift
BLENDER_PID="$(pgrep -x Blender | head -1)"
[ -n "$BLENDER_PID" ] || { echo "Blender is not running" >&2; exit 1; }

wait_for() {
	i=0
	while [ $i -lt 80 ]; do grep -q "$1" "$L" && return 0; sleep 0.5; i=$((i + 1)); done
	echo "timed out waiting for: $1" >&2
}

# Phone crop per scenario (w:h:x:y on the 3840x1080 display): around where the action is.
case "$SCENARIO" in
	chore) SECONDS_TO_RECORD=22; CROP="1280:720:0:0" ;;
	doit) SECONDS_TO_RECORD=18; CROP="1600:900:500:60" ;;
	lesson) SECONDS_TO_RECORD=45; CROP="1920:1080:0:0" ;;
	*) echo "usage: $0 chore|doit|lesson" >&2; exit 2 ;;
esac

tools/blender.py --reset
# Buddy starts where the user's cursor is: put it over the viewport, inside the phone crop.
python3 -c "import Quartz; Quartz.CGWarpMouseCursorPosition((900, 620))"
: > "$L"
RELAY_BUDDY_SPEAK=0 nohup "$B" >/dev/null 2>&1 &
BUDDY_PID=$!
sleep 1.5
RAW="build/phase2-$SCENARIO.mov"
nohup build/proofrec "$RAW" "$SECONDS_TO_RECORD" "$BLENDER_PID" "$BUDDY_PID" > /tmp/relay-buddy-proofrec.log 2>&1 &
REC_PID=$!
sleep 1.5

case "$SCENARIO" in
	chore)
		"$B" --send "how do I bevel?" --target Blender
		;;
	doit)
		"$B" --send "bevel it for me" --target Blender
		wait_for "did:"
		sleep 2.2
		"$B" --undo
		;;
	lesson)
		"$B" --send "teach me to start a donut: add a torus, scale it up, shade it smooth" --target Blender
		wait_for "lesson point step 1"; sleep 2.5
		tools/blender.py 'with ctx(): bpy.ops.mesh.primitive_torus_add(location=(0, 0, 1.6))'
		wait_for "lesson point step 2"; sleep 2.5
		tools/blender.py 'bpy.context.view_layer.objects.active.scale = (1.8, 1.8, 1.8)'
		wait_for "lesson point step 3"; sleep 2.5
		tools/blender.py 'with ctx(): bpy.ops.object.shade_smooth()'
		wait_for "lesson end"
		;;
esac

wait $REC_PID || true
cat /tmp/relay-buddy-proofrec.log "$L"
tools/blender.py --reset
ffmpeg -loglevel error -y -i "$RAW" -vf "crop=$CROP,scale=1280:720" -c:v libx264 -crf 22 \
	-preset slow -pix_fmt yuv420p -movflags +faststart "proof/phase2-$SCENARIO.mp4"
echo "saved proof/phase2-$SCENARIO.mp4"
