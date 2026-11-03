#!/bin/zsh
# Unattended GSD driver: one fresh `claude -p` session per phase, like starting a new session
# after each phase and saying "continue". State carries over only through .planning/ + git.
set -u
cd "${0:A:h}"
export PATH="$PWD/node_modules/.bin:$PATH"
mkdir -p logs
NOTE="Isaac is unavailable; never wait for input. For every question or config choice, pick the recommended/default option and continue."
run() {
  claude -p --dangerously-skip-permissions --output-format stream-json --verbose "$1

$NOTE" >> "logs/$2.jsonl" 2>> logs/stderr.log
}
# Let an in-flight headless run (e.g. new-project from an earlier driver) finish first.
while pgrep -f "claude -p --dangerously-skip-permissions" >/dev/null; do sleep 30; done
[[ -f .planning/ROADMAP.md ]] || run "/gsd:new-project --auto @IDEA.md" new-project
next_phase() {
  gsd-sdk query roadmap.analyze 2>/dev/null |
    jq -r '[.phases[] | select(.disk_status != "complete" or .roadmap_complete == false)][0].number // empty'
}
tries=0
last=""
while phase=$(next_phase) && [[ -n "$phase" ]]; do
  # Same phase twice in a row = it made no progress last session; allow one retry, then stop.
  if [[ "$phase" == "$last" ]]; then (( ++tries > 1 )) && { echo "STUCK phase $phase $(date)" >> logs/status; break; }; else tries=0; fi
  last=$phase
  echo "$(date '+%F %T') phase $phase start" >> logs/phases.log
  run "/gsd:autonomous --only $phase" "phase-$phase"
  echo "$(date '+%F %T') phase $phase end, HEAD $(git rev-parse --short HEAD)" >> logs/phases.log
done
echo "DONE $(date)" >> logs/status
