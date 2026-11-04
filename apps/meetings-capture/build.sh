#!/bin/sh
# Builds build/Relay Meetings.app with swiftc (no Xcode project). relay-desktop-deploy.ts copies it
# into Relay.app/Contents/Helpers and signs it with Relay in one --deep pass; the ad-hoc signature
# here is only for local runs.
#   sh build.sh        the app
#   sh build.sh test   the logic tests (Tests/main.swift with every source but main.swift)
set -e
cd "$(dirname "$0")"

FLAGS="-swift-version 5 -target arm64-apple-macosx14.4 -framework CoreAudio -framework AVFoundation -framework AppKit"

if [ "$1" = test ]; then
	mkdir -p build
	# shellcheck disable=SC2046,SC2086
	swiftc -Onone $FLAGS -o build/relay-meetings-tests Tests/main.swift $(ls Sources/*.swift | grep -v '/main.swift$')
	exec build/relay-meetings-tests
fi

APP="build/Relay Meetings.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Resources/Info.plist "$APP/Contents/Info.plist"
# shellcheck disable=SC2086
swiftc -O $FLAGS -o "$APP/Contents/MacOS/RelayMeetingCapture" Sources/*.swift
codesign --force --sign - "$APP" >/dev/null 2>&1
echo "built $APP"
