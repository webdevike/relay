#!/usr/bin/env bash
# Install one Relay prerequisite. Idempotent: an installed tool is left alone.
#
#   install.sh brew|bun|omp|herdr|tailscale|relay-host [relay-host args: <root> <hostName>]
#
# stdout protocol: `PROGRESS <0-100> <message>` lines, then `OK <version>` (exit 0) or `ERR <message>` (exit 1).
# Installer chatter goes to ~/Library/Logs/Relay/setup.log. Admin steps use the macOS password prompt; we never see it.
set -eEuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"
install_err_trap
require_macos

TOOL="${1:-}"
[ -n "$TOOL" ] || fail "usage: install.sh brew|bun|omp|herdr|tailscale|relay-host"
shift || true

already() { # already <tool>: exit OK when installed
  local v
  if [ -n "$(tool_path "$1")" ]; then
    v="$(tool_version "$1")"
    ok "${v:-installed} (already installed)"
  fi
}

# Official installers drop binaries in these dirs; make the new one visible to this script.
refresh_path() { hash -r; }

verified_version() { # verified_version <tool>: fail unless it now resolves and runs
  refresh_path
  local v
  [ -n "$(tool_path "$1")" ] || fail "$1 install finished but the binary was not found; see $SETUP_LOG ($(last_log_lines 2))"
  v="$(tool_version "$1")"
  [ -n "$v" ] || fail "$1 installed but does not report a version; see $SETUP_LOG"
  printf '%s' "$v"
}

# Wire herdr's omp status extension (best effort, only when both tools exist).
herdr_omp_integration() {
  if [ -n "$(tool_path herdr)" ] && [ -n "$(tool_path omp)" ]; then
    run_logged herdr integration install omp || log_line "herdr integration install omp failed (non-fatal)"
  fi
}

install_pkg_as_admin() { # install_pkg_as_admin <pkg> <label>
  local pkg="$1" label="$2"
  pkgutil --check-signature "$pkg" 2>&1 | grep -q 'Status: signed' \
    || fail "$label package signature check failed; refusing to install"
  progress 70 "Installing $label (macOS will ask for your password)"
  admin_run "/usr/sbin/installer -pkg '$pkg' -target /" \
    || fail "$label install was cancelled or failed (the macOS password prompt may have been dismissed)"
}

case "$TOOL" in
  brew)
    already brew
    need_network
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    progress 5 "Downloading Homebrew installer"
    download "https://github.com/Homebrew/brew/releases/latest/download/Homebrew.pkg" "$tmp/Homebrew.pkg" \
      || fail "could not download Homebrew.pkg from GitHub"
    progress 50 "Verifying Homebrew installer"
    install_pkg_as_admin "$tmp/Homebrew.pkg" "Homebrew"
    progress 95 "Checking Homebrew"
    v="$(verified_version brew)"
    ok "$v"
    ;;

  bun)
    already bun
    need_network
    progress 10 "Downloading Bun"
    # Official installer: https://bun.sh/docs/installation. Installs to ~/.bun and edits the shell rc for PATH.
    curl -fsSL https://bun.sh/install | bash >>"$SETUP_LOG" 2>&1 \
      || fail "Bun installer failed: $(last_log_lines 2)"
    export PATH="$HOME/.bun/bin:$PATH"
    progress 95 "Checking Bun"
    v="$(verified_version bun)"
    ok "$v"
    ;;

  omp)
    already omp
    need_network
    progress 10 "Downloading omp"
    # Official installer (omp.sh): prebuilt binary into ~/.local/bin/omp, sha256-verified. --binary needs no Bun.
    curl -fsSL https://omp.sh/install | sh -s -- --binary >>"$SETUP_LOG" 2>&1 \
      || fail "omp installer failed: $(last_log_lines 2)"
    progress 85 "Checking omp"
    v="$(verified_version omp)"
    herdr_omp_integration
    ok "$v"
    ;;

  herdr)
    already herdr
    need_network
    progress 10 "Downloading herdr"
    # Official installer (herdr.dev): checksum-verified binary into ~/.local/bin/herdr.
    curl -fsSL https://herdr.dev/install.sh | sh >>"$SETUP_LOG" 2>&1 \
      || fail "herdr installer failed: $(last_log_lines 2)"
    progress 85 "Checking herdr"
    v="$(verified_version herdr)"
    herdr_omp_integration
    ok "$v"
    ;;

  tailscale)
    # Prefer the standalone app (works headless-CLI inside the bundle, no App Store sign-in needed).
    if [ -d /Applications/Tailscale.app ]; then
      v="$(tool_version tailscale)"
      ok "${v:-installed} (already installed)"
    fi
    need_network
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    progress 5 "Downloading Tailscale"
    download "https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg" "$tmp/Tailscale.pkg" \
      || fail "could not download the Tailscale installer from pkgs.tailscale.com"
    progress 50 "Verifying Tailscale installer"
    install_pkg_as_admin "$tmp/Tailscale.pkg" "Tailscale"
    progress 90 "Starting Tailscale"
    run_logged open -a Tailscale || true
    i=0
    while [ -z "$(tool_path tailscale)" ] && [ "$i" -lt 20 ]; do sleep 1; i=$((i + 1)); done
    v="$(verified_version tailscale)"
    ok "$v"
    ;;

  relay-host)
    # Delegates to install-host.sh. Args: <root> <hostName>; defaults so the bare form works for tests.
    root="${1:-${RELAY_HOME_ROOT:-$HOME/Relay}}"
    name="${2:-$(scutil --get ComputerName 2>/dev/null || hostname -s)}"
    exec "$HERE/install-host.sh" "$root" "$name"
    ;;

  *)
    fail "unknown tool '$TOOL' (expected brew|bun|omp|herdr|tailscale|relay-host)"
    ;;
esac
