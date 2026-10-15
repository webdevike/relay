#!/bin/zsh
# Overnight watchdog for the unattended GSD run. Called every 20m by Eva job `evaos-electron-watch`.
# Driver dead before DONE -> restart (max 4). After DONE -> one finalize pass that makes the app runnable.
set -u
cd "${0:A:h}"
export PATH="$PWD/node_modules/.bin:$PATH"
mkdir -p logs
log() { echo "$(date '+%F %T') $*" >> logs/watchdog.log; }
pgrep -f "run-phases.sh|claude -p --dangerously-skip-permissions" >/dev/null && { log "running, HEAD $(git rev-parse --short HEAD)"; exit 0; }
[[ -f logs/finalized ]] && exit 0
if ! grep -q DONE logs/status 2>/dev/null; then
  n=$(cat logs/restarts 2>/dev/null || echo 0)
  (( n >= 4 )) && { log "driver dead, restart cap hit"; exit 0; }
  echo $((n + 1)) > logs/restarts
  log "driver dead without DONE, restart $((n + 1))"
  nohup "$PWD/run-phases.sh" >> logs/driver.log 2>&1 &
  exit 0
fi
log "finalize pass"
touch logs/finalized
claude -p --dangerously-skip-permissions --output-format stream-json --verbose "Isaac wakes up soon and wants to try this Electron port of EvaOS. Never wait for input.
1. Read .planning/ (ROADMAP, STATE) and note which phases finished and which did not.
2. Install deps, build, run the tests, and launch the app headlessly with Playwright for Electron. Fix anything that stops it from building or launching. Commit fixes.
3. Make a launchable app: package a macOS .app (electron-builder, unsigned, dir target) and copy it to ~/Applications/EvaOS Electron.app.
4. Write TRY.md at the repo root: how to open it, what works, what is missing vs current EvaOS, known bugs, and screenshot paths under proof/. No em dashes.
5. Add a '## Verify by hand' checklist to TRY.md: every 'still-needs-isaac' item and every '## Deferred gaps' entry from all phases' VERIFICATION.md files, grouped by phase. Commit." >> logs/finalize.jsonl 2>> logs/stderr.log
log "finalize done"
