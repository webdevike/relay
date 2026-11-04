#!/bin/sh
# Builds "Relay Host.app" (arm64) into build/.
#   ./build.sh 0.2.0            build only
#   ./build.sh 0.2.0 --release  also publish GitHub release host-v0.2.0, which every installed copy
#                               picks up within an hour (or via "Check for Updates")
#   ./build.sh 0.2.0 --dist     self-contained app for a new user's machine: the relay-host binary, the
#                               input dylib and the omp extensions inside, signed with the local
#                               'Apple Development' identity (ad hoc without one), copied to
#                               dist/Relay Host.app; no GitHub release. Relay Desktop's installer
#                               ships it as Relay.app/Contents/Resources/RelayHost/Relay Host.app.
set -eu
VERSION=${1:?version}
cd "$(dirname "$0")"
APP="build/Relay Host.app"
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS"
# The live canvas web client, embedded in relay-host as one HTML file (text import in canvas/page.ts).
# Its own isolated install (React 19.3, not hoisted over the phone's React).
(cd ../../packages/canvas-web && { [ -d node_modules ] || bun install --frozen-lockfile; } && bun run build)
(cd ../linux && bun build --compile --target=bun-darwin-arm64 src/main.ts --outfile "../mac-host/$APP/Contents/MacOS/relay-host")
swiftc -O -target arm64-apple-macos13 RelayHost.swift -o "$APP/Contents/MacOS/RelayHost"
clang -O2 -Wall -Wextra -Werror -dynamiclib -framework ApplicationServices -mmacosx-version-min=13.0 RelayInput.c -o "$APP/Contents/MacOS/relay-input.dylib"
IDENTITY=$(security find-identity -v -p codesigning | sed -n 's/.*\([0-9A-F]\{40\}\) "Apple Development.*/\1/p' | head -n 1)
codesign --force --sign "${IDENTITY:--}" --identifier com.ike.relay.input "$APP/Contents/MacOS/relay-input.dylib"
codesign --force --sign "${IDENTITY:--}" --identifier com.ike.relay.daemon "$APP/Contents/MacOS/relay-host"
# omp extensions the host installs into ~/.omp/agent/extensions when missing (agents/extensions.ts).
mkdir -p "$APP/Contents/Resources/omp-extension"
# Bundled: the source imports ../src/agents/* by relative path, which only resolves from a repo checkout
# (Isaac's symlink). omp's own packages stay external; omp resolves them when it loads the extension.
(cd ../linux && bun build omp-extension/relay-bridge.ts --target=bun --format=esm --external '@oh-my-pi/*' \
  --outfile "../mac-host/$APP/Contents/Resources/omp-extension/relay-bridge.ts")
# herdr's own agent-state extension, when this machine has it; otherwise the host runs `herdr integration install omp`.
[ -f "$HOME/.omp/agent/extensions/herdr-omp-agent-state.ts" ] && cp "$HOME/.omp/agent/extensions/herdr-omp-agent-state.ts" "$APP/Contents/Resources/omp-extension/"
# The meetings transcription worker (meetings/asr.ts runs it with the venv from apps/linux/asr/setup.sh).
mkdir -p "$APP/Contents/Resources/asr"
cp ../linux/asr/relay_asr.py "$APP/Contents/Resources/asr/"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Relay Host</string>
<key>CFBundleIdentifier</key><string>com.ike.relay.host</string>
<key>CFBundleExecutable</key><string>RelayHost</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>$VERSION</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
EOF
# Stable signing preserves Accessibility identity across input-backend upgrades.
# No --deep: nested helpers are already signed above.
codesign --force --sign "${IDENTITY:--}" "$APP"
(cd build && rm -f RelayHost.zip && ditto -ck --keepParent "Relay Host.app" RelayHost.zip)
if [ "${2:-}" = "--dist" ]; then
  codesign --verify --strict "$APP"
  rm -rf dist && mkdir -p dist
  ditto "$APP" "dist/Relay Host.app"
  echo "built dist/Relay Host.app"
fi
if [ "${2:-}" = "--release" ]; then
  gh release create "host-v$VERSION" build/RelayHost.zip --repo webdevike/relay --title "Relay Host $VERSION" --notes "Relay Host $VERSION" --latest
fi
