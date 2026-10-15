#!/bin/zsh
# Unattended GSD run: new-project (auto) then autonomous phases until done.
set -u
cd "${0:A:h}"
export PATH="$PWD/node_modules/.bin:$PATH"
mkdir -p logs
NOTE="Isaac is unavailable; never wait for input. For every question or config choice, pick the recommended/default option (YOLO mode, parallel on, research on, verifier on, git commits on) and continue."
run() {
  claude -p --dangerously-skip-permissions --output-format stream-json --verbose "$1

$NOTE" >> "logs/$2.jsonl" 2>> logs/stderr.log
}
[[ -f .planning/ROADMAP.md ]] || run "/gsd:new-project --auto @IDEA.md" new-project
for i in {1..12}; do
  before=$(git rev-parse HEAD)
  run "/gsd:autonomous" "autonomous-$i"
  # Stop once a pass makes no commits: nothing left to do, or it is stuck.
  [[ "$(git rev-parse HEAD)" == "$before" ]] && break
done
