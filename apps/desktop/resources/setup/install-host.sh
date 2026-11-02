#!/usr/bin/env bash
# Install Relay Host for this user and start it.
#
#   install-host.sh <root> <hostName>
#
#   root      absolute path of the ICM home base (becomes host.json agentHome / --agent-home)
#   hostName  how this Mac shows up on the iPhone ("Jane's Mac Studio")
#
# Needs the app: $RELAY_HOST_APP (dev) or <Relay.app>/Contents/Resources/RelayHost/Relay Host.app (packaged).
# Writes: ~/Applications/Relay Host.app, ~/.config/relay/host.json,
#         ~/Library/LaunchAgents/dev.relay.host.plist (+ dev.relay.herdr.plist when no herdr server is being kept alive).
# Refuses (ERR) when Isaac-style `ai.eva.relay-host` is installed. stdout: PROGRESS/OK/ERR.
set -eEuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"
install_err_trap
require_macos

ROOT="${1:-}"
NAME="${2:-}"
PORT="${RELAY_HOST_PORT:-7817}"
[ -n "$ROOT" ] && [ -n "$NAME" ] || fail "usage: install-host.sh <root> <hostName>"
case "$ROOT" in /*) ;; *) fail "root must be an absolute path, got '$ROOT'" ;; esac
case "$PORT" in ''|*[!0-9]*) fail "invalid RELAY_HOST_PORT '$PORT'" ;; esac

UID_NUM="$(id -u)"
LA_DIR="$HOME/Library/LaunchAgents"
HOST_LABEL="dev.relay.host"
HERDR_LABEL="dev.relay.herdr"
HOST_PLIST="$LA_DIR/$HOST_LABEL.plist"
HERDR_PLIST="$LA_DIR/$HERDR_LABEL.plist"
APP_DEST="$HOME/Applications/Relay Host.app"
STATE_DIR="$(relay_state_dir)"
SERVE_JSON="$STATE_DIR/serve.json"
LOG_DIR="$HOME/Library/Logs"
SAFE_PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

xml_esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
loaded() { launchctl print "gui/$UID_NUM/$1" >/dev/null 2>&1; }

# ---- 0. refuse to touch an existing different setup ----
if [ -e "$LA_DIR/ai.eva.relay-host.plist" ] || loaded ai.eva.relay-host; then
  fail "an existing Relay Host setup (ai.eva.relay-host) is installed on this Mac; refusing to overwrite it"
fi
[ -d "$ROOT" ] || fail "home base folder $ROOT does not exist; create it (scaffold-home.sh) first"

# ---- 1. locate the app ----
progress 5 "Locating Relay Host"
SRC="$(relay_host_app_source)"
if [ -z "$SRC" ]; then
  [ -d "$APP_DEST" ] || fail "Relay Host.app not found (set RELAY_HOST_APP or use the packaged Relay app)"
  SRC="$APP_DEST"
fi
[ -x "$SRC/Contents/MacOS/relay-host" ] || fail "$SRC does not contain Contents/MacOS/relay-host"

# ---- 2. stop our previous instance, then copy the app ----
progress 15 "Installing Relay Host.app"
if loaded "$HOST_LABEL"; then launchctl bootout "gui/$UID_NUM/$HOST_LABEL" >>"$SETUP_LOG" 2>&1 || true; fi
mkdir -p "$HOME/Applications"
if [ "$SRC" != "$APP_DEST" ]; then
  rm -rf "$APP_DEST"
  ditto "$SRC" "$APP_DEST"
  xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true
fi
HOST_BIN="$APP_DEST/Contents/MacOS/relay-host"
[ -x "$HOST_BIN" ] || fail "install of Relay Host.app did not produce $HOST_BIN"
VERSION="$(plist_get "$APP_DEST/Contents/Info.plist" CFBundleShortVersionString)"

# ---- 3. a free port ----
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port $PORT is already in use by another program; close it or set RELAY_HOST_PORT"
fi

# ---- 4. host.json ----
progress 30 "Writing host config"
mkdir -p "$STATE_DIR"
printf '{\n  "agentHome": "%s",\n  "name": "%s",\n  "port": %s\n}\n' "$(json_esc "$ROOT")" "$(json_esc "$NAME")" "$PORT" >"$STATE_DIR/host.json.tmp"
mv "$STATE_DIR/host.json.tmp" "$STATE_DIR/host.json"
rm -f "$SERVE_JSON"   # stale from a crashed run; the new host rewrites it

# ---- 5. omp extension the host injects into assistant sessions (shipped in the app when available) ----
EXT_SRC="$APP_DEST/Contents/Resources/omp-extension/relay-bridge.ts"
EXT_DIR="$HOME/.omp/agent/extensions"
if [ -f "$EXT_SRC" ]; then
  mkdir -p "$EXT_DIR"
  # A symlink is a developer checkout: leave it. A plain copy came from an earlier install: refresh it.
  [ -L "$EXT_DIR/relay-bridge.ts" ] || cp "$EXT_SRC" "$EXT_DIR/relay-bridge.ts"
fi

# Assistants run omp in a hidden herdr pane: omp's own first-run wizard would wait there forever for
# keys nobody can press. Relay's wizard already did its job (tools, AI sign-in).
if [ -n "$(tool_path omp)" ] && [ "$(omp config get startup.setupWizard 2>/dev/null)" != "false" ]; then
  run_logged omp config set startup.setupWizard false || fail "could not turn off omp's first-run setup: $(last_log_lines 2)"
fi

# ---- 6. herdr server agent (only when nobody keeps one alive already) ----
mkdir -p "$LOG_DIR" "$HOME/Library/Application Support/Relay/boards"
HERDR_BIN="$(tool_path herdr)"
if [ -n "$HERDR_BIN" ] && ! loaded ai.eva.herdr && ! loaded "$HERDR_LABEL" && ! "$HERDR_BIN" workspace list >/dev/null 2>&1; then
  progress 45 "Setting up herdr"
  mkdir -p "$LA_DIR"
  cat >"$HERDR_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$HERDR_LABEL</string>
<key>ProgramArguments</key><array><string>$(xml_esc "$HERDR_BIN")</string><string>server</string></array>
<key>WorkingDirectory</key><string>$(xml_esc "$ROOT")</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>$(xml_esc "$SAFE_PATH")</string><key>SHELL</key><string>/bin/zsh</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>$(xml_esc "$LOG_DIR/RelayHerdr.log")</string><key>StandardErrorPath</key><string>$(xml_esc "$LOG_DIR/RelayHerdr.log")</string>
</dict></plist>
PLIST
  launchctl bootout "gui/$UID_NUM/$HERDR_LABEL" >>"$SETUP_LOG" 2>&1 || true
  launchctl bootstrap "gui/$UID_NUM" "$HERDR_PLIST" >>"$SETUP_LOG" 2>&1 || fail "could not start herdr: $(last_log_lines 2)"
fi

# ---- 7. Relay Host LaunchAgent ----
progress 60 "Installing LaunchAgent"
mkdir -p "$LA_DIR"
cat >"$HOST_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>$(xml_esc "$HOME")</string>
		<key>PATH</key>
		<string>$(xml_esc "$SAFE_PATH")</string>
	</dict>
	<key>KeepAlive</key>
	<true/>
	<key>Label</key>
	<string>$HOST_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml_esc "$HOST_BIN")</string>
		<string>serve</string>
		<string>--port</string>
		<string>$PORT</string>
		<string>--name</string>
		<string>$(xml_esc "$NAME")</string>
		<string>--agent-home</string>
		<string>$(xml_esc "$ROOT")</string>
		<string>--no-clipboard</string>
		<string>--boards</string>
		<string>$(xml_esc "$HOME/Library/Application Support/Relay/boards")</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>$(xml_esc "$LOG_DIR/RelayHost.log")</string>
	<key>StandardOutPath</key>
	<string>$(xml_esc "$LOG_DIR/RelayHost.log")</string>
	<key>ThrottleInterval</key>
	<integer>10</integer>
</dict>
</plist>
PLIST
plutil -lint "$HOST_PLIST" >>"$SETUP_LOG" 2>&1 || fail "generated LaunchAgent is invalid"

progress 70 "Starting Relay Host"
launchctl bootstrap "gui/$UID_NUM" "$HOST_PLIST" >>"$SETUP_LOG" 2>&1 || fail "could not start Relay Host: $(last_log_lines 2)"

# ---- 8. wait for serve.json with a live pid ----
i=0
while [ "$i" -lt 60 ]; do
  live="$(relay_host_live)"
  if [ -n "$live" ]; then
    progress 100 "Relay Host is running on port ${live%% *}"
    ok "${VERSION:-installed}"
  fi
  sleep 1
  i=$((i + 1))
  [ $((i % 10)) -eq 0 ] && progress $((70 + i / 3)) "Waiting for Relay Host"
done
fail "Relay Host did not start within 60s; see $LOG_DIR/RelayHost.log"
