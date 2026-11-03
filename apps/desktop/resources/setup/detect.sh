#!/usr/bin/env bash
# Read-only probe of what Relay setup needs. Prints ONE JSON object on stdout, nothing else.
# Never installs, starts, logs in, or writes anything.
#
# {"brew":{installed,version,path},"bun":{...},
#  "omp":{installed,version,path,loggedIn,providers:[...]},"herdr":{...},
#  "tailscale":{installed,version,path,running,loggedIn,tailnetIp?},
#  "relayHost":{installed,running,version,port?}}
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

bool() { if [ "$1" = 1 ]; then printf true; else printf false; fi; }

# Basic {installed,version,path} members (no braces) for a tool.
basic() {
  local path version installed=0
  path="$(tool_path "$1")"
  [ -n "$path" ] && installed=1
  version="$(tool_version "$1" || true)"
  printf '"installed":%s,"version":%s,"path":%s' "$(bool "$installed")" "$(jstr "$version")" "$(jstr "$path")"
}

# ---- clt / brew / bun / herdr ----
CLT="{$(basic clt)}"
BREW="{$(basic brew)}"
BUN="{$(basic bun)}"
HERDR="{$(basic herdr)}"

# ---- omp: providers come from `omp usage accounts --json` (local, ~0.1s) plus API keys in ~/.omp/agent/.env ----
providers=""
add_provider() {
  case ",$providers," in *",$1,"*) return ;; esac
  providers="${providers:+$providers,}$1"
}
if [ -n "$(tool_path omp)" ]; then
  accounts_json="$(omp usage accounts --json 2>/dev/null || true)"
  if [ -n "$accounts_json" ]; then
    count="$(printf '%s' "$accounts_json" | json_get accounts)"
    case "$count" in ''|*[!0-9]*) count=0 ;; esac
    i=0
    while [ "$i" -lt "$count" ]; do
      p="$(printf '%s' "$accounts_json" | json_get "accounts.$i.provider")"
      # mcp_oauth:* entries are MCP server sign-ins, not model providers.
      case "$p" in ''|mcp_oauth*) ;; *) add_provider "$p" ;; esac
      i=$((i + 1))
    done
  fi
  env_file="$HOME/.omp/agent/.env"
  if [ -f "$env_file" ]; then
    grep -q '^ANTHROPIC_API_KEY=.\{1,\}' "$env_file" 2>/dev/null && add_provider anthropic
    grep -q '^OPENAI_API_KEY=.\{1,\}' "$env_file" 2>/dev/null && add_provider openai
  fi
fi
providers_json=""
if [ -n "$providers" ]; then
  oldifs="$IFS"; IFS=,
  for p in $providers; do providers_json="${providers_json:+$providers_json,}\"$(json_esc "$p")\""; done
  IFS="$oldifs"
fi
logged_in=0; [ -n "$providers" ] && logged_in=1
OMP="{$(basic omp),\"loggedIn\":$(bool "$logged_in"),\"providers\":[$providers_json]}"

# ---- tailscale ----
ts_running=0; ts_logged_in=0; ts_ip=""
ts_bin="$(tool_path tailscale)"
# Any Tailscale CLI call can launch the GUI (Welcome window, "Add VPN Configurations" prompt), and the app CLI never
# answers until its network extension is approved. Only ask an app that is already running; otherwise report
# {installed, running:false, loggedIn:false} from Info.plist alone. Never launch it.
if [ -n "$ts_bin" ] && pgrep -xq Tailscale; then
  ts_json="$(run_timeout 5 "$ts_bin" status --json 2>/dev/null || true)"
  if [ -n "$ts_json" ]; then
    state="$(printf '%s' "$ts_json" | json_get BackendState)"
    [ "$state" = "Running" ] && ts_running=1
    case "$state" in Running|Starting|Stopped|NeedsMachineAuth) ts_logged_in=1 ;; esac
    if [ "$ts_logged_in" = 1 ]; then
      ts_ip="$(printf '%s' "$ts_json" | json_get Self.TailscaleIPs.0)"
    fi
  fi
fi
TAILSCALE="{$(basic tailscale),\"running\":$(bool "$ts_running"),\"loggedIn\":$(bool "$ts_logged_in")"
[ -n "$ts_ip" ] && TAILSCALE="$TAILSCALE,\"tailnetIp\":$(jstr "$ts_ip")"
TAILSCALE="$TAILSCALE}"

# ---- relay host ----
host_app="$(relay_host_app_installed)"
host_installed=0; host_version=""; host_running=0; host_port=""
if [ -n "$host_app" ]; then
  host_installed=1
  host_version="$(plist_get "$host_app/Contents/Info.plist" CFBundleShortVersionString)"
fi
live="$(relay_host_live)"
if [ -n "$live" ]; then
  host_running=1
  host_port="${live%% *}"
fi
RELAYHOST="{\"installed\":$(bool "$host_installed"),\"running\":$(bool "$host_running"),\"version\":$(jstr "$host_version")"
case "$host_port" in ''|*[!0-9]*) ;; *) RELAYHOST="$RELAYHOST,\"port\":$host_port" ;; esac
RELAYHOST="$RELAYHOST}"

printf '{"clt":%s,"brew":%s,"bun":%s,"omp":%s,"herdr":%s,"tailscale":%s,"relayHost":%s}\n' \
  "$CLT" "$BREW" "$BUN" "$OMP" "$HERDR" "$TAILSCALE" "$RELAYHOST"
