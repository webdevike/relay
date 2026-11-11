#!/bin/sh
# Pure Swift logic of the native modules, compiled and run with the Mac's swiftc (no simulator).
set -eu
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
swiftc -swift-version 5 -o "$out/liveness" modules/live-call/ios/LiveCallLiveness.swift modules/live-call/test/main.swift
"$out/liveness"
