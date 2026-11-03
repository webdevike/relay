import Foundation

// Entry point for the standalone voice test binary (see tools/voice-test.sh). The app itself
// calls VoiceTest from main.swift instead.
let code = await VoiceTest.run(CommandLine.arguments)
exit(code)
