# Shared helpers for the Relay setup scripts. Source it, never run it:
#   . "$(dirname "$0")/lib.sh"
#
# Protocol the long-running scripts (install.sh, install-host.sh, ai-login.sh, start-host.sh) speak on stdout:
#   PROGRESS <0-100> <message>   zero or more
#   OK <message>                 last line, exit 0
#   ERR <message>                last line, exit 1
# Everything noisy (installer chatter, curl progress) goes to the setup log, never to stdout.
#
# macOS and Linux. Platform-specific steps check `is_macos` / `is_linux` themselves.

OS_NAME="$(uname -s)"
is_macos() { [ "$OS_NAME" = "Darwin" ]; }
is_linux() { [ "$OS_NAME" = "Linux" ]; }
# NixOS: generic downloaded binaries do not run there without nix-ld; the flake provides the tools.
is_nixos() { [ -e /etc/NIXOS ] || grep -Eq '^ID="?nixos"?$' /etc/os-release 2>/dev/null; }

# GUI apps start with a minimal PATH; the tools we manage live in these places.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# NixOS keeps user and system tools (and the pkexec wrapper) in profile folders; appended, so the PATH the
# launcher gave us wins.
if is_linux; then
  export PATH="$PATH:$HOME/.nix-profile/bin:/etc/profiles/per-user/${USER:-$(id -un)}/bin:/run/current-system/sw/bin:/run/wrappers/bin"
fi

if is_macos; then
  SETUP_LOG_DIR="${RELAY_SETUP_LOG_DIR:-$HOME/Library/Logs/Relay}"
  THIS_MACHINE="this Mac"
else
  SETUP_LOG_DIR="${RELAY_SETUP_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/relay}"
  THIS_MACHINE="this computer"
fi
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
  # Reap both quietly: bash otherwise reports "Terminated"/"Killed" job notices on stderr, which the app shows.
  rc=0; wait "$pid" 2>/dev/null || rc=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
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

# ---- JSON (no jq needed) ------------------------------------------------------

# Escape a string for embedding in a JSON string literal.
json_esc() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e $'s/\t/\\\\t/g' | tr '\r\n' '  '
}

# "text" or null when empty.
jstr() {
  if [ -z "${1:-}" ]; then printf 'null'; else printf '"%s"' "$(json_esc "$1")"; fi
}

# What reads JSON here: plutil on macOS (always present); on Linux jq when present, else bun, else node.
# RELAY_JSON_TOOL=plutil|jq|bun|node forces one (tests). Prints nothing when none is available.
json_tool() {
  if [ -n "${RELAY_JSON_TOOL:-}" ]; then printf '%s' "$RELAY_JSON_TOOL"
  elif is_macos; then printf plutil
  elif have jq; then printf jq
  elif have bun; then printf bun
  elif have node; then printf node
  else return 1
  fi
}

# jq and JS read a dotted path the way `plutil -extract <path> raw` does: a digit segment indexes an array;
# an array prints its length, an object its keys (one per line); null, a missing key or bad JSON fail.
JSON_GET_JQ='reduce ($k | split("."))[] as $s (.;
  if type == "array" then (if ($s | test("^[0-9]+$")) then .[$s | tonumber] else error("not an index") end)
  elif type == "object" then .[$s]
  else error("no such key") end)
  | if . == null then error("missing")
    elif type == "array" then length
    elif type == "object" then (keys | join("\n"))
    else . end'
JSON_GET_JS='const fs = require("fs");
let v;
try { v = JSON.parse(fs.readFileSync(process.env.RELAY_JSON_FILE || 0, "utf8")); } catch { process.exit(1); }
for (const s of process.env.RELAY_JSON_KEY.split(".")) {
  if (Array.isArray(v)) { if (!/^[0-9]+$/.test(s)) process.exit(1); v = v[Number(s)]; }
  else if (v !== null && typeof v === "object") { v = Object.prototype.hasOwnProperty.call(v, s) ? v[s] : undefined; }
  else process.exit(1);
  if (v === undefined) process.exit(1);
}
if (v === null) process.exit(1);
process.stdout.write(Array.isArray(v) ? String(v.length) : typeof v === "object" ? Object.keys(v).sort().join("\n") : String(v));'
JSON_VALID_JS='try { JSON.parse(require("fs").readFileSync(process.env.RELAY_JSON_FILE, "utf8")); } catch { process.exit(1); }'

# Extract a value from JSON on stdin (or a file). Prints the raw value; a missing key, null or invalid JSON
# prints nothing (plutil writes some errors to stdout, so output is emitted only after a successful extraction).
# usage: printf '%s' "$json" | json_get Self.TailscaleIPs.0      json_get assistants.0.model answers.json
json_get() {
  local key="$1" file="${2:-}" value tool
  tool="$(json_tool)" || return 0
  case "$tool" in
    plutil) value="$(plutil -extract "$key" raw -o - "${file:--}" 2>/dev/null)" || return 0 ;;
    jq)
      if [ -n "$file" ]; then value="$(jq -r --arg k "$key" "$JSON_GET_JQ" "$file" 2>/dev/null)" || return 0
      else value="$(jq -r --arg k "$key" "$JSON_GET_JQ" 2>/dev/null)" || return 0
      fi ;;
    bun|node) value="$(RELAY_JSON_KEY="$key" RELAY_JSON_FILE="$file" "$tool" -e "$JSON_GET_JS" 2>/dev/null)" || return 0 ;;
    *) return 0 ;;
  esac
  printf '%s' "$value"
}

# json_valid <file>: exit 0 when the file holds valid JSON.
json_valid() {
  local tool
  tool="$(json_tool)" || return 1
  case "$tool" in
    plutil) plutil -convert json -o /dev/null "$1" >/dev/null 2>&1 ;;
    jq) jq empty "$1" >/dev/null 2>&1 ;;
    bun|node) RELAY_JSON_FILE="$1" "$tool" -e "$JSON_VALID_JS" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# ---- admin, network ------------------------------------------------------------

# Run a shell command as root through the system's password prompt. We never see the password.
# macOS: the standard administrator prompt. Linux: polkit's pkexec; without it, fail (never a sudo prompt).
# usage: admin_run <command> [<reason shown in the prompt>]
admin_run() {
  local cmd="$1" reason="${2:-Relay setup needs your password to continue.}" esc rsn
  ensure_log
  if is_linux; then
    have pkexec || fail "this step needs administrator rights, and pkexec (polkit) is not installed; run it yourself in a terminal: $cmd"
    log_line "pkexec: $reason"
    pkexec /bin/sh -c "$cmd" >>"$SETUP_LOG" 2>&1
    return
  fi
  esc="$(printf '%s' "$cmd" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  rsn="$(printf '%s' "$reason" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  osascript -e "do shell script \"$esc\" with prompt \"$rsn\" with administrator privileges" >>"$SETUP_LOG" 2>&1
}

# Download URL to a file (resumable, logged). Fails with ERR text on network problems.
download() {
  local url="$1" dest="$2"
  log_line "download $url"
  curl -fL --retry 3 --connect-timeout 15 -o "$dest" "$url" >>"$SETUP_LOG" 2>&1
}

# need_network [url]: fail early, with a message a person can act on, when this machine cannot reach the
# server the step downloads from (default github.com). Logged with a timestamp, not bare curl output.
need_network() {
  local url="${1:-https://github.com}" host
  host="${url#https://}"; host="${host%%/*}"
  log_line "checking internet: $url"
  # Any HTTP answer means the server is reachable (Apple's update host answers 404 at its root).
  curl -sS --connect-timeout 8 -o /dev/null -I "$url" >>"$SETUP_LOG" 2>&1 \
    || fail "$THIS_MACHINE is not online (could not reach $host). Check Wi-Fi or Ethernet, then press Retry"
}

# How this machine is called: the macOS computer name; on Linux the pretty hostname, else the hostname.
computer_name() {
  local n=""
  if is_macos; then
    scutil --get ComputerName 2>/dev/null || hostname -s
    return
  fi
  have hostnamectl && n="$(hostnamectl --pretty 2>/dev/null || true)"
  [ -n "$n" ] || n="$(hostname 2>/dev/null || uname -n)"
  printf '%s' "$n"
}

plist_get() { /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null || true; }

# Wire herdr's omp status extension (best effort, only when both tools exist).
herdr_omp_integration() {
  if [ -n "$(tool_path herdr)" ] && [ -n "$(tool_path omp)" ]; then
    # A fresh omp has not created its extensions folder yet; herdr refuses to install without it.
    mkdir -p "$HOME/.omp/agent/extensions"
    run_logged herdr integration install omp || log_line "herdr integration install omp failed (non-fatal)"
  fi
}

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

# ---- Linux: the relay-host binary (Nix wrapper PATH or $RELAY_HOST_BIN) ----------------------------------

relay_host_bin() {
  if [ -n "${RELAY_HOST_BIN:-}" ] && [ -x "$RELAY_HOST_BIN" ]; then printf '%s' "$RELAY_HOST_BIN"
  else tool_path relay-host
  fi
}

# The version the launcher exports ($RELAY_HOST_VERSION), else empty.
relay_host_version() { printf '%s' "${RELAY_HOST_VERSION:-}"; }

# The bundled omp bridge extension: $RELAY_OMP_EXTENSION_DIR, else <prefix>/Resources/omp-extension next to
# <prefix>/bin/relay-host (the binary or the symlink a profile points at). Empty when none is found.
relay_bridge_source() {
  local bin real d
  if [ -n "${RELAY_OMP_EXTENSION_DIR:-}" ] && [ -f "$RELAY_OMP_EXTENSION_DIR/relay-bridge.ts" ]; then
    printf '%s' "$RELAY_OMP_EXTENSION_DIR/relay-bridge.ts"; return 0
  fi
  bin="$(relay_host_bin)"
  [ -n "$bin" ] || return 0
  real="$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")"
  for d in "$(dirname "$bin")" "$(dirname "$real")"; do
    if [ -f "$d/../Resources/omp-extension/relay-bridge.ts" ]; then
      printf '%s' "$(cd "$d/../Resources/omp-extension" && pwd)/relay-bridge.ts"; return 0
    fi
  done
}

# Linux: port <n> has a listener on this machine.
port_in_use() {
  if have ss; then
    [ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]
  elif have lsof; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}
