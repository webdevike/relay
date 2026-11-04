#!/bin/sh
# Builds build/Relay Meetings.app (accessory, no Dock icon) signed with "Relay Local Signing" when
# its keychain is present, so the Audio Capture and Microphone grants stick across rebuilds.
set -e
cd "$(dirname "$0")"
APP="build/Relay Meetings.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
swiftc -O -swift-version 5 -target arm64-apple-macosx14.4 \
	-framework CoreAudio -framework AVFoundation -framework AppKit \
	-o "$APP/Contents/MacOS/RelayMeetingCapture" Sources/main.swift
KC="$HOME/Library/Keychains/relay-signing.keychain-db"
PW="$HOME/Eva/secrets/relay-signing-keychain.pw"
SHA=""
if [ -f "$KC" ] && [ -f "$PW" ]; then
	security unlock-keychain -p "$(cat "$PW")" "$KC"
	SHA="$(security find-identity -p codesigning "$KC" | awk '/"Relay Local Signing"/ {print $2; exit}')"
fi
if [ -n "$SHA" ]; then
	codesign --force --keychain "$KC" -s "$SHA" "$APP"
	echo "built $APP (Relay Local Signing)"
else
	codesign --force -s - "$APP"
	echo "built $APP (ad hoc)"
fi
