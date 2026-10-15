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
  run "/gsd:autonomous" "autonomous-$i"
  grep -q '"phases_remaining": *0\|All phases complete' "logs/autonomous-$i.jsonl" && break
  [[ -z "$(git status --porcelain .planning)" ]] && ! git log -1 --since='20 minutes ago' -q >/dev/null 2>&1 && break
done
echo "DONE $(date)" >> logs/status
