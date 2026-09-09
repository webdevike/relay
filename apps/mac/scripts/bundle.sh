#!/bin/sh
# Build Relay into a signed .app bundle so macOS remembers its Accessibility grant.
#
# TCC (Accessibility) is keyed to a binary's code signature, NOT to whoever launched it, which is
# why a grant to the raw `swift run` binary never carries over between rebuilds. With a STABLE
# self-signed identity, macOS keys the grant to that identity's designated requirement, so it
# survives every rebuild. Ad-hoc signatures key to the cdhash and reset on every rebuild, so we
# prefer the identity and fall back to ad-hoc only if it is missing.
#
# One-time identity setup (creates a local code-signing cert, no Apple account):
#   sh scripts/setup-identity.sh
# Then grant "Relay" once under Accessibility.
set -euo pipefail

cd "$(dirname "$0")/.."

APP="build/Relay.app"
IDENTITY="Relay Local Signing"

echo "building Relay (release)..."
swift build -c release

BIN="$(swift build -c release --show-bin-path)/Relay"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Relay"
cp Resources/Info.plist "$APP/Contents/Info.plist"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
	echo "signing with stable identity '$IDENTITY' (grants persist across rebuilds)"
	codesign --force --identifier com.ike.relay --sign "$IDENTITY" "$APP"
else
	echo "warning: '$IDENTITY' not found; ad-hoc signing (grants reset each rebuild)."
	echo "         run 'sh scripts/setup-identity.sh' once to make grants durable."
	codesign --force --identifier com.ike.relay --sign - "$APP"
fi

echo "built $APP"
echo "launch:  open $APP        (must be 'open', not the raw binary, for TCC identity)"
echo "grant Relay once in System Settings > Privacy & Security > Accessibility."
