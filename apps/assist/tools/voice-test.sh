#!/bin/sh
# Builds build/voice-test (Sources/Voice + a tiny main) and runs the voice checks without a mic.
#   tools/voice-test.sh build
#   tools/voice-test.sh stt "where is the bevel tool"     say -> aiff -> m4a -> transcript, must match
#   tools/voice-test.sh tts "Click Bevel, then drag to size it."   writes /tmp/buddy-say.wav and plays it
#   tools/voice-test.sh barge                              speak a long line, cut it at 1.2 s
set -e
cd "$(dirname "$0")/.."
BIN=build/voice-test

build() {
	mkdir -p build
	swiftc -O -swift-version 5 -target arm64-apple-macosx14.0 \
		-framework AVFoundation -framework Cocoa -framework Carbon \
		-o "$BIN" Sources/Voice/*.swift tools/voicetest/main.swift
}

case "$1" in
build) build ;;
stt)
	build
	say -v Samantha -o /tmp/buddy-q.aiff "${2:-where is the bevel tool}"
	afconvert -f m4af -d aac /tmp/buddy-q.aiff /tmp/buddy-q.m4a
	"$BIN" --voice-test /tmp/buddy-q.m4a
	;;
tts)
	build
	"$BIN" --voice-say "${2:-Click Bevel, then drag to size it.}" --out /tmp/buddy-say.wav
	ffprobe -v error -show_entries format=duration -of default=nw=1 /tmp/buddy-say.wav
	;;
barge)
	build
	"$BIN" --voice-barge "Okay, here is the long way round. First open the Edit menu, then pick Preferences, then look for the Add-ons tab on the left, and turn the switch on." --after 1.2
	;;
*) echo "usage: $0 build|stt [phrase]|tts [text]|barge" >&2; exit 2 ;;
esac
