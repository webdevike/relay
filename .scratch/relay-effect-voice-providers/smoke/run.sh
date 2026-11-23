#!/usr/bin/env bash
# run.sh <scenario> <provider|none> <reply-ms> <host-flags...> -- <client command and args...>
# Starts an isolated host (own temp dir, own XDG_CONFIG_HOME), runs the client against it, stops only the host it started.
set -u
SC=$1; PROV=$2; REPLY=$3; shift 3
HOSTFLAGS=(); while [ "$1" != "--" ]; do HOSTFLAGS+=("$1"); shift; done; shift
HERE=$(cd "$(dirname "$0")" && pwd)
EV=/tmp/relay-smoke-evidence/$SC; mkdir -p "$EV"
T=$(mktemp -d /tmp/relay-smoke-XXXX)
export XDG_CONFIG_HOME=$T/xdg
if [ "$PROV" = none ]; then unset RELAY_VOICE_PROVIDER; else export RELAY_VOICE_PROVIDER=$PROV; fi
# Keys come from <agentHome>/secrets by path only: the inherited environment must not supply them.
env -u DEEPGRAM_API_KEY -u OPENAI_API_KEY ${EXTRA_ENV:-} bun "$HERE/host.ts" --dir "$T" --reply-ms "$REPLY" ${HOSTFLAGS[@]+"${HOSTFLAGS[@]}"} >"$EV/host.stdout" 2>&1 &
HP=$!
for i in $(seq 1 50); do grep -q READY "$EV/host.stdout" 2>/dev/null && break; sleep 0.2; done
PORT=$(cat "$T/port") || { echo "host did not start"; kill $HP; exit 2; }
cd "$HERE/../../../apps/linux"
"$@" --host "ws://127.0.0.1:$PORT/relay" >"$EV/client.stdout" 2>"$EV/client.stderr"; RC=$?
sleep 2
# Sockets the host still holds after the client hung up (clean hangup evidence): only the listener may remain.
lsof -nP -a -p $HP -i TCP 2>/dev/null | awk 'NR>1{print $8, $9, $10}' >"$EV/host-sockets.txt"
kill $HP 2>/dev/null; wait $HP 2>/dev/null
cp "$T/host.log" "$EV/host.log" 2>/dev/null; cp "$T/delegations.jsonl" "$EV/delegations.jsonl" 2>/dev/null
echo "scenario=$SC rc=$RC dir=$EV tmp=$T"
