#!/bin/sh
# Builds build/RelayBuddy.app with swiftc (no Xcode project needed).
set -e
cd "$(dirname "$0")"

APP=build/RelayBuddy.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Resources/Info.plist "$APP/Contents/Info.plist"
# Draws assistant avatars with Relay's DiceBear packages (Sources/Assistant.swift caches the PNGs).
cp tools/render-avatar.ts "$APP/Contents/Resources/render-avatar.ts"

swiftc -O -swift-version 5 -target arm64-apple-macosx14.0 \
	-framework Cocoa -framework Carbon -framework ScreenCaptureKit -framework QuartzCore -framework AVFoundation \
	-o "$APP/Contents/MacOS/RelayBuddy" Sources/*.swift Sources/Voice/*.swift

# A stable signing identity keeps macOS privacy grants across rebuilds; ad-hoc otherwise.
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development/ {print $2; exit}')"
codesign --force --sign "${IDENTITY:--}" "$APP" >/dev/null 2>&1
echo "built $APP (signed: ${IDENTITY:-ad-hoc})"
