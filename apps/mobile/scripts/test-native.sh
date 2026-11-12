#!/bin/sh
# Pure Swift logic of the native modules, compiled and run with the Mac's swiftc (no simulator).
# Also keeps docs/state-machines/live-call-lifecycle.md's diagram in step with LiveCallLifecycle:
# fails when it is stale, rewrites it with UPDATE_MACHINE_DOCS=1.
set -eu
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
# The Swift reconnect grace must equal the host's; the test fails when they drift.
grace_ms="$(sed -n 's/^export const LIVE_RECONNECT_GRACE_MS = \([0-9_]*\);.*/\1/p' ../../packages/protocol/src/index.ts | tr -d _)"
swiftc -swift-version 5 -o "$out/livecall" \
  modules/live-call/ios/LiveCallLiveness.swift \
  modules/live-call/ios/LiveCallLifecycle.swift \
  modules/live-call/test/main.swift
LIVE_RECONNECT_GRACE_MS="$grace_ms" "$out/livecall"

doc=../../docs/state-machines/live-call-lifecycle.md
"$out/livecall" --mermaid >"$out/diagram"
awk -v diagram="$out/diagram" '
  /^<!-- diagram:start/ {
    print
    while ((getline line < diagram) > 0) print line
    skipping = 1
    next
  }
  /^<!-- diagram:end -->/ { skipping = 0 }
  !skipping { print }
' "$doc" >"$out/doc"
if cmp -s "$doc" "$out/doc"; then
  echo "ok   $doc is current"
elif [ "${UPDATE_MACHINE_DOCS:-}" = "1" ]; then
  cp "$out/doc" "$doc"
  echo "updated $doc"
else
  echo "FAIL $doc is stale: run UPDATE_MACHINE_DOCS=1 pnpm test:native"
  exit 1
fi
