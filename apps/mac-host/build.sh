#!/bin/sh
# Builds "Relay Host.app" (arm64). `./build.sh 0.2.0 --release` also publishes GitHub release host-v0.2.0,
# which every installed copy picks up within an hour (or via "Check for Updates").
set -eu
VERSION=${1:?version}
cd "$(dirname "$0")"
APP="build/Relay Host.app"
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS"
(cd ../linux && bun build --compile --target=bun-darwin-arm64 src/main.ts --outfile "../mac-host/$APP/Contents/MacOS/relay-host")
swiftc -O -target arm64-apple-macos13 RelayHost.swift -o "$APP/Contents/MacOS/RelayHost"
# Live-view capture helper (ScreenCaptureKit, macOS 14+ APIs). It owns its Screen Recording grant,
# so it is signed with a stable identity when one exists: an ad-hoc grant dies with every rebuild.
swiftc -O -target arm64-apple-macos14 RelayScreen.swift -o "$APP/Contents/MacOS/relay-screen"
IDENTITY=$(security find-identity -v -p codesigning | sed -n 's/.*\([0-9A-F]\{40\}\) "Apple Development.*/\1/p' | head -n 1)
codesign --force --sign "${IDENTITY:--}" --identifier com.ike.relay.screen "$APP/Contents/MacOS/relay-screen"
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
# shortcut: ad-hoc signed (no Developer ID cert on this Mac); first launch needs right-click > Open. Upgrade: Developer ID + notarize.
# No --deep: that would re-sign relay-screen ad hoc; the app seal records it as already signed.
codesign --force --sign - "$APP"
(cd build && rm -f RelayHost.zip && ditto -ck --keepParent "Relay Host.app" RelayHost.zip)
if [ "${2:-}" = "--release" ]; then
  gh release create "host-v$VERSION" build/RelayHost.zip --repo webdevike/relay --title "Relay Host $VERSION" --notes "Relay Host $VERSION" --latest
fi
