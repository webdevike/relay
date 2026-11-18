#!/usr/bin/env bash
# Start herdr and Relay Host for this user (Linux only).
#
#   start-host.sh [--restart]
#
# herdr: when no herdr server answers (`herdr workspace list`), start the `herdr.service` user unit when it
# exists, else `herdr server` detached.
# Relay Host: a live host (serve.json pid alive) is left alone, or with --restart restarted. Otherwise the
# `relay-host.service` user unit is started when `systemctl --user cat relay-host.service` works, else
# `relay-host serve` (it reads port, name and agentHome from ~/.config/relay/host.json) runs detached, logging
# to ${XDG_STATE_HOME:-~/.local/state}/relay/host.log. Waits up to 60 s for serve.json with a live pid.
#
# stdout protocol: PROGRESS lines, then `OK running on port <port>` or `ERR <message>`.
set -eEuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"
install_err_trap
is_linux || fail "start-host.sh is Linux only"

# Relay Desktop (Electron) runs this with descriptors it never marked close-on-exec, its DevTools listen
# socket among them: the detached host and herdr would hold them for life, and a relaunched app could not
# take its port back. Close every inherited descriptor above stderr (255 is the script bash is reading).
for fd in /proc/self/fd/*; do
  fd="${fd##*/}"
  case "$fd" in 0 | 1 | 2 | 255 | *[!0-9]*) continue ;; esac
  eval "exec $fd>&-" 2>/dev/null || true
done

RESTART=0
case "${1:-}" in
  --restart) RESTART=1 ;;
  '') ;;
  *) fail "usage: start-host.sh [--restart]" ;;
esac

STATE_DIR="$(relay_state_dir)"
SERVE_JSON="$STATE_DIR/serve.json"
RUN_LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/relay"
HOST_LOG="$RUN_LOG_DIR/host.log"
HERDR_LOG="$RUN_LOG_DIR/herdr.log"
mkdir -p "$RUN_LOG_DIR"

# A systemd user unit with this name is installed (NixOS module, home-manager, or by hand).
have_unit() { have systemctl && systemctl --user cat "$1" >/dev/null 2>&1; }

# Start a command in its own session, detached from this script (and from the app that runs it), output to <log>.
spawn_detached() { # spawn_detached <log> <cmd...>
  local log="$1"
  shift
  log_line "start (detached): $*"
  if have setsid; then
    (cd "$WORK_DIR" && exec setsid "$@") >>"$log" 2>&1 </dev/null &
  else
    (cd "$WORK_DIR" && exec nohup "$@") >>"$log" 2>&1 </dev/null &
  fi
}

# The home base the host serves (host.json agentHome), else the home folder: herdr's panes start there.
WORK_DIR="$(json_get agentHome "$STATE_DIR/host.json")"
case "$WORK_DIR" in "~"|"~/"*) WORK_DIR="$HOME${WORK_DIR#\~}" ;; esac
[ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ] || WORK_DIR="$HOME"

# ---- herdr -------------------------------------------------------------------------------------------------
HERDR_BIN="$(tool_path herdr)"
herdr_up() { run_timeout 10 "$HERDR_BIN" workspace list >/dev/null 2>&1; }
if [ -n "$HERDR_BIN" ] && ! herdr_up; then
  progress 10 "Starting herdr"
  if have_unit herdr.service; then
    run_logged systemctl --user start herdr.service || fail "could not start herdr.service: $(last_log_lines 2)"
  else
    spawn_detached "$HERDR_LOG" "$HERDR_BIN" server
  fi
  i=0
  while [ "$i" -lt 15 ] && ! herdr_up; do sleep 1; i=$((i + 1)); done
  # Not fatal: the host starts herdr itself when it needs one; chats then report what went wrong.
  herdr_up || log_line "herdr server did not answer within 15s; see $HERDR_LOG"
elif [ -z "$HERDR_BIN" ]; then
  log_line "herdr is not installed; assistants will not start until it is"
fi

# ---- Relay Host --------------------------------------------------------------------------------------------
live="$(relay_host_live)"
if [ -n "$live" ] && [ "$RESTART" = 0 ]; then
  progress 100 "Relay Host is running on port ${live%% *}"
  ok "running on port ${live%% *}"
fi
old_pid=""
[ -z "$live" ] || old_pid="${live#* }"

HOST_BIN="$(relay_host_bin)"
[ -n "$HOST_BIN" ] || fail "relay-host was not found on PATH; start Relay with the flake (nix run .#relay) or set RELAY_HOST_BIN"
[ -f "$STATE_DIR/host.json" ] || log_line "no $STATE_DIR/host.json; relay-host serve uses its defaults"

# Stop a live host the unit does not own, so two hosts never fight over the port.
stop_pid() { # stop_pid <pid>
  local pid="$1" i=0
  kill "$pid" 2>/dev/null || return 0
  while [ "$i" -lt 10 ] && kill -0 "$pid" 2>/dev/null; do sleep 1; i=$((i + 1)); done
  kill -9 "$pid" 2>/dev/null || true
}

progress 30 "Starting Relay Host"
if have_unit relay-host.service; then
  if [ -n "$old_pid" ]; then
    unit_pid="$(systemctl --user show -p MainPID --value relay-host.service 2>/dev/null || true)"
    [ "$unit_pid" = "$old_pid" ] || stop_pid "$old_pid"
  fi
  if [ "$RESTART" = 1 ]; then
    run_logged systemctl --user restart relay-host.service || fail "could not restart relay-host.service: $(last_log_lines 2)"
  else
    run_logged systemctl --user start relay-host.service || fail "could not start relay-host.service: $(last_log_lines 2)"
  fi
  where="journalctl --user -u relay-host"
else
  [ -z "$old_pid" ] || stop_pid "$old_pid"
  spawn_detached "$HOST_LOG" "$HOST_BIN" serve
  where="$HOST_LOG"
fi

# ---- wait for serve.json with a live pid (a new one when restarting) ----------------------------------------
i=0
while [ "$i" -lt 60 ]; do
  live="$(relay_host_live)"
  if [ -n "$live" ] && [ "${live#* }" != "$old_pid" ]; then
    progress 100 "Relay Host is running on port ${live%% *}"
    ok "running on port ${live%% *}"
  fi
  sleep 1
  i=$((i + 1))
  [ $((i % 10)) -eq 0 ] && progress $((30 + i)) "Waiting for Relay Host"
done
fail "Relay Host did not start within 60s; see $where"
