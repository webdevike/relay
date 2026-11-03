#!/usr/bin/env bash
# Sign omp in to an AI provider.
#
#   ai-login.sh <anthropic|openai>             omp's own browser login (`omp login`): Claude account / ChatGPT account
#   ai-login.sh --api-key <anthropic|openai>   reads the API key from STDIN, stores it in ~/.omp/agent/.env (chmod 600)
#
# Browser login: STDIN is handed to `omp login` and must stay open until it ends. omp listens for the
# browser's redirect (ChatGPT: http://localhost:1455/auth/callback) and reads a pasted redirect address
# or code from stdin at the same time; it gives up, callback listener and all, the moment stdin closes.
# Relay keeps a pipe open and writes the address the user pastes; closing it cancels the sign-in.
#
# stdout protocol: PROGRESS lines, then `OK <provider>` or `ERR <message>`. The key is never echoed or logged.
set -eEuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"
install_err_trap
require_macos

API_KEY_MODE=0
if [ "${1:-}" = "--api-key" ]; then API_KEY_MODE=1; shift; fi
PROVIDER="${1:-}"

case "$PROVIDER" in
  anthropic) OMP_PROVIDER=anthropic; ENV_NAME=ANTHROPIC_API_KEY ;;
  # A ChatGPT subscription signs in as omp's `openai-codex`; the plain `openai` provider is an API key.
  openai) OMP_PROVIDER=openai-codex; ENV_NAME=OPENAI_API_KEY ;;
  *) fail "usage: ai-login.sh [--api-key] <anthropic|openai>" ;;
esac

[ -n "$(tool_path omp)" ] || fail "omp is not installed; run install.sh omp first"

has_account() { # has_account <omp provider id>
  local json count i p
  json="$(omp usage accounts --json </dev/null 2>/dev/null || true)"
  [ -n "$json" ] || return 1
  count="$(printf '%s' "$json" | json_get accounts)"
  case "$count" in ''|*[!0-9]*) return 1 ;; esac
  i=0
  while [ "$i" -lt "$count" ]; do
    p="$(printf '%s' "$json" | json_get "accounts.$i.provider")"
    [ "$p" = "$1" ] && return 0
    i=$((i + 1))
  done
  return 1
}

if [ "$API_KEY_MODE" = 1 ]; then
  progress 10 "Reading API key"
  key="$(cat | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$key" ] || fail "no API key was provided on stdin"
  case "$key" in *[[:space:]\"\'\\]*) fail "the API key contains characters that are not valid in a key" ;; esac
  progress 40 "Checking the key with $PROVIDER"
  # Ask the provider's model list with the key (headers via stdin config, so the key never reaches argv or the log).
  case "$PROVIDER" in
    anthropic) url=https://api.anthropic.com/v1/models
      cfg="header = \"x-api-key: $key\"
header = \"anthropic-version: 2023-06-01\"" ;;
    openai) url=https://api.openai.com/v1/models
      cfg="header = \"Authorization: Bearer $key\"" ;;
  esac
  code="$(printf '%s\n' "$cfg" | curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -K - "$url" 2>/dev/null || true)"
  case "$code" in
    200) ;;
    401|403) fail "$PROVIDER did not accept this key; check it and paste it again" ;;
    ''|000) fail "could not reach $PROVIDER to check the key; check your internet connection" ;;
    *) fail "$PROVIDER answered HTTP $code when checking the key" ;;
  esac
  env_dir="$HOME/.omp/agent"
  env_file="$env_dir/.env"
  mkdir -p "$env_dir"
  umask 077
  tmp="$(mktemp "$env_dir/.env.XXXXXX")"
  if [ -f "$env_file" ]; then grep -v "^${ENV_NAME}=" "$env_file" >"$tmp" || true; fi
  printf '%s=%s\n' "$ENV_NAME" "$key" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$env_file"
  progress 100 "Saved $ENV_NAME"
  ok "$PROVIDER"
fi

if has_account "$OMP_PROVIDER"; then
  ok "$PROVIDER (already signed in)"
fi

progress 10 "Opening your browser to sign in to $PROVIDER"
log_line "omp login $OMP_PROVIDER"
from=$(( $(wc -c <"$SETUP_LOG" 2>/dev/null || echo 0) + 1 ))
# omp opens the browser, waits for the callback (or a pasted address on stdin) and stores the
# credential in ~/.omp/agent/agent.db.
if ! omp login "$OMP_PROVIDER" >>"$SETUP_LOG" 2>&1; then
  # This run's `Login failed: <why>` line, without the provider's JSON body that may follow it.
  why="$(tail -c "+$from" "$SETUP_LOG" | grep -m1 'Login failed:' | sed -e 's/^.*Login failed: //' -e 's/[[:space:]]*{.*$//' || true)"
  [ -n "$why" ] || why="$(last_log_lines 2)"
  case "$why" in
    *"stdin closed"*|*"Login cancelled"*) fail "sign-in to $PROVIDER was cancelled" ;;
    *"in use"*) fail "another sign-in is still holding the port $PROVIDER redirects back to (quit any other Codex or omp sign-in), then try again" ;;
    *) fail "sign-in to $PROVIDER did not finish: $why" ;;
  esac
fi
progress 90 "Checking sign-in"
has_account "$OMP_PROVIDER" || fail "omp finished but no $PROVIDER account was saved; try again"
ok "$PROVIDER"
