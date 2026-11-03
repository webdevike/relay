# Shared helpers for the Relay setup scripts. Source it, never run it:
#   . "$(dirname "$0")/lib.sh"
#
# Protocol the long-running scripts (install.sh, install-host.sh, ai-login.sh) speak on stdout:
#   PROGRESS <0-100> <message>   zero or more
#   OK <message>                 last line, exit 0
#   ERR <message>                last line, exit 1
# Everything noisy (installer chatter, curl progress) goes to the setup log, never to stdout.

# GUI apps start with a minimal PATH; the tools we manage live in these places.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SETUP_LOG_DIR="${RELAY_SETUP_LOG_DIR:-$HOME/Library/Logs/Relay}"
SETUP_LOG="$SETUP_LOG_DIR/setup.log"
ensure_log() { mkdir -p "$SETUP_LOG_DIR" 2>/dev/null || true; }

TAILSCALE_APP_CLI="/Applications/Tailscale.app/Contents/MacOS/Tailscale"

# ---- protocol -------------------------------------------------------------

progress() { printf 'PROGRESS %s %s\n' "$1" "$2"; }

ok() {
  printf 'OK %s\n' "$*"
  exit 0
}

fail() {
  # One line, always: collapse newlines so the parser never sees a multi-line ERR.
  printf 'ERR %s\n' "$(printf '%s' "$*" | tr '\r\n' '  ')"
  exit 1
}

# Turn any unexpected command failure into a protocol ERR. Call after `set -eEuo pipefail`.
install_err_trap() {
  trap 'fail "unexpected failure (line $LINENO); see $SETUP_LOG"' ERR
}

log_line() { ensure_log; printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$SETUP_LOG" 2>/dev/null || true; }

# Run a command with stdout+stderr appended to the setup log. Returns its exit status.
run_logged() {
  log_line "\$ $*"
  "$@" >>"$SETUP_LOG" 2>&1
}

last_log_lines() { tail -n "${1:-3}" "$SETUP_LOG" 2>/dev/null | tr '\r\n' '  '; }

# ---- tool discovery ---------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# Run a command, killing it after <secs>. Returns its status (137 when killed). macOS has no `timeout`.
# The Tailscale app CLI blocks forever until its network extension is approved, so probes need a cap.
run_timeout() {
  local secs="$1" pid watcher rc
  shift
  "$@" &
  pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  watcher=$!
  rc=0; wait "$pid" || rc=$?
  kill "$watcher" 2>/dev/null || true
  return "$rc"
}

# Absolute path of a tool, or empty.
tool_path() {
  case "$1" in
    clt)
      # xcode-select -p alone is not enough: the developer dir must really hold git
      # (/usr/bin/git on a fresh Mac is only a stub that pops Apple's installer).
      local dev
      dev="$(xcode-select -p 2>/dev/null || true)"
      if [ -n "$dev" ] && [ -x "$dev/usr/bin/git" ]; then echo "$dev/usr/bin/git"; fi ;;
    brew)
      if have brew; then command -v brew
      elif [ -x /opt/homebrew/bin/brew ]; then echo /opt/homebrew/bin/brew
      elif [ -x /usr/local/bin/brew ]; then echo /usr/local/bin/brew
      fi ;;
    tailscale)
      if have tailscale; then command -v tailscale
      elif [ -x "$TAILSCALE_APP_CLI" ]; then echo "$TAILSCALE_APP_CLI"
      fi ;;
    *) have "$1" && command -v "$1" || true ;;
  esac
}

# First line of a tool's version, normalised to just the number ("" if unknown).
tool_version() {
  local bin
  bin="$(tool_path "$1")"
  [ -n "$bin" ] || return 0
  case "$1" in
    clt) pkgutil --pkg-info=com.apple.pkg.CLTools_Executables 2>/dev/null | sed -n 's/^version: //p' ;;
    brew) "$bin" --version 2>/dev/null | sed -n '1s/^Homebrew[[:space:]]*//;1s/^>=//;1s/[[:space:]].*//;1p' ;;
    bun) "$bin" --version 2>/dev/null | sed -n '1p' ;;
    omp) "$bin" --version 2>/dev/null | sed -n '1s#^omp/##;1s#^v##;1p' ;;
    herdr) "$bin" --version 2>/dev/null | sed -n '1s/^herdr[[:space:]]*//p' ;;
    tailscale)
      # Never run the CLI for the version: it can launch the app (VPN prompts). Prefer the bundle version.
      if [ -f /Applications/Tailscale.app/Contents/Info.plist ]; then
        plist_get /Applications/Tailscale.app/Contents/Info.plist CFBundleShortVersionString
      else
        { run_timeout 5 "$bin" version 2>/dev/null || true; } | sed -n '1p'
      fi ;;
  esac
}

# ---- JSON (no jq) -------------------------------------------------------------

# Escape a string for embedding in a JSON string literal.
json_esc() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e $'s/\t/\\\\t/g' | tr '\r\n' '  '
}

# "text" or null when empty.
jstr() {
  if [ -z "${1:-}" ]; then printf 'null'; else printf '"%s"' "$(json_esc "$1")"; fi
}

# Extract a value from JSON on stdin with plutil (always present on macOS). Prints raw value.
# usage: printf '%s' "$json" | json_get Self.TailscaleIPs.0
json_get() { plutil -extract "$1" raw -o - - 2>/dev/null || true; }

# ---- macOS helpers ------------------------------------------------------------

# Run a shell command as root through the standard macOS password prompt. We never see the password.
# usage: admin_run <command> [<reason shown in the prompt>]
admin_run() {
  local cmd="$1" reason="${2:-Relay setup needs your password to continue.}" esc rsn
  esc="$(printf '%s' "$cmd" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  rsn="$(printf '%s' "$reason" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  ensure_log
  osascript -e "do shell script \"$esc\" with prompt \"$rsn\" with administrator privileges" >>"$SETUP_LOG" 2>&1
}

# Download URL to a file (resumable, logged). Fails with ERR text on network problems.
download() {
  local url="$1" dest="$2"
  log_line "download $url"
  curl -fL --retry 3 --connect-timeout 15 -o "$dest" "$url" >>"$SETUP_LOG" 2>&1
}

# need_network [url]: fail early, with a message a person can act on, when this Mac cannot reach the
# server the step downloads from (default github.com). Logged with a timestamp, not bare curl output.
need_network() {
  local url="${1:-https://github.com}" host
  host="${url#https://}"; host="${host%%/*}"
  log_line "checking internet: $url"
  # Any HTTP answer means the server is reachable (Apple's update host answers 404 at its root).
  curl -sS --connect-timeout 8 -o /dev/null -I "$url" >>"$SETUP_LOG" 2>&1 \
    || fail "this Mac is not online (could not reach $host). Check Wi-Fi or Ethernet, then press Retry"
}

require_macos() {
  [ "$(uname -s)" = "Darwin" ] || fail "these setup scripts only support macOS"
}

plist_get() { /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null || true; }

# Relay Host bookkeeping (matches apps/linux state dir).
relay_state_dir() { printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/relay"; }

# Port + pid from serve.json -> "port pid" when the pid is alive, else empty.
relay_host_live() {
  local f
  f="$(relay_state_dir)/serve.json"
  [ -f "$f" ] || return 0
  local content port pid
  content="$(cat "$f" 2>/dev/null || true)"
  port="$(printf '%s' "$content" | json_get port)"
  pid="$(printf '%s' "$content" | json_get pid)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && printf '%s %s' "$port" "$pid"
  return 0
}

# Where the packaged Relay Host app lives: env override, packaged Resources, then installed copies.
relay_host_app_source() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -n "${RELAY_HOST_APP:-}" ] && [ -d "$RELAY_HOST_APP" ]; then printf '%s' "$RELAY_HOST_APP"; return; fi
  # here = Relay.app/Contents/Resources/setup -> ../RelayHost/Relay Host.app
  if [ -d "$here/../RelayHost/Relay Host.app" ]; then (cd "$here/../RelayHost" && printf '%s/Relay Host.app' "$(pwd)"); return; fi
}

relay_host_app_installed() {
  if [ -d "$HOME/Applications/Relay Host.app" ]; then printf '%s' "$HOME/Applications/Relay Host.app"
  elif [ -d "/Applications/Relay Host.app" ]; then printf '%s' "/Applications/Relay Host.app"
  fi
}
