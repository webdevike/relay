#!/usr/bin/env bash
# Recompute nix/hashes.json after a lockfile change (pnpm-lock.yaml, apps/desktop/pnpm-lock.yaml,
# packages/widget-runtime/pnpm-lock.yaml). Needs Linux with Nix
# (CI's nix workflow runs it on main). Builds each dependency fetch; a stale hash fails with the right
# one, which is written back. Prints the keys it changed; exit 0 either way.
set -euo pipefail
cd "$(dirname "$0")/.."
HASHES=nix/hashes.json

declare -A ATTR=(
  [root]=".#relay-host.rootPnpmDeps"
  [desktop]=".#relay.desktopPnpmDeps"
  [widgetRuntime]=".#relay.widgetPnpmDeps"
)

for key in root desktop widgetRuntime; do
  log=$(mktemp)
  if nix build "${ATTR[$key]}" --no-link --print-build-logs >"$log" 2>&1; then
    rm -f "$log"
    continue
  fi
  got=$(sed -n 's/^ *got: *\(sha256-[A-Za-z0-9+/=]*\).*/\1/p' "$log" | tail -n 1)
  if [ -z "$got" ]; then
    echo "update-hashes: ${ATTR[$key]} failed for another reason:" >&2
    tail -n 40 "$log" >&2
    exit 1
  fi
  jq --arg k "$key" --arg v "$got" '.[$k] = $v' "$HASHES" >"$HASHES.tmp" && mv "$HASHES.tmp" "$HASHES"
  echo "$key $got"
  rm -f "$log"
done
