#!/bin/zsh
# Scope cut (Isaac, 2026-10-15): stop the run once phase $1 is done, before the next phase does
# any work. Watches logs/phases.log; on "phase <next> start" it kills the driver and its claude
# session, then marks DONE so the watchdog runs the finalize pass.
set -u
cd "${0:A:h}"
last=$1
next=$((last + 1))
until grep -q "phase $next start" logs/phases.log 2>/dev/null; do sleep 15; done
pkill -f run-phases.sh
pkill -f "claude -p --dangerously-skip-permissions"
echo "$(date '+%F %T') scope cut: stopped before phase $next" >> logs/phases.log
echo "DONE scope cut after phase $last $(date)" > logs/status
