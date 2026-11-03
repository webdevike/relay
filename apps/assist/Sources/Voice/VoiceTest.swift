import Foundation

/// Command-line checks for the voice stack, no microphone needed.
///
///   --voice-test <audio file>            file -> streaming transcript (partials to stderr, final to stdout)
///   --voice-say "text" [--out f.wav]     text -> speech; writes f.wav (default /tmp/buddy-say.wav) and plays it
///        [--no-play]                     skip the speakers
///        [--as nova|astra]               whose liveVoice to use (agents.json), default the personal assistant
///   --voice-barge "long text" [--after s] speak, cut it off after s seconds (default 1.2), report the stop time
///
/// `VoiceTest.handles(args)` tells main.swift whether to call `VoiceTest.run(args)` and exit.
enum VoiceTest {
    static func handles(_ args: [String]) -> Bool {
        args.contains("--voice-test") || args.contains("--voice-say") || args.contains("--voice-barge")
    }

    private static func value(_ flag: String, in args: [String]) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static func run(_ args: [String]) async -> Int32 {
        do {
            if let path = value("--voice-test", in: args) {
                let input = FileVoiceInput(url: URL(fileURLWithPath: path))
                input.onPartial = { FileHandle.standardError.write(Data("partial: \($0)\n".utf8)) }
                let started = Date()
                try await input.start()
                let text = try await input.stop()
                FileHandle.standardError.write(Data(String(format: "transcribed in %.2fs\n", Date().timeIntervalSince(started)).utf8))
                print(text)
                return text.isEmpty ? 1 : 0
            }
            if let text = value("--voice-say", in: args) {
                let speech = OpenAISpeech()
                speech.playback = !args.contains("--no-play")
                let out = URL(fileURLWithPath: value("--out", in: args) ?? "/tmp/buddy-say.wav")
                speech.recordTo = out
                let started = Date()
                let who = value("--as", in: args).flatMap(Assistants.named) ?? Assistants.personal
                try await speech.speak(text, voice: who.liveVoice)
                let total = Date().timeIntervalSince(started)
                print(String(format: "first audio %.2fs, done %.2fs, wrote %@", speech.firstAudioLatency ?? -1, total, out.path))
                return 0
            }
            if let text = value("--voice-barge", in: args) {
                let after = Double(value("--after", in: args) ?? "") ?? 1.2
                let speech = OpenAISpeech()
                let started = Date()
                let speaking = Task { try await speech.speak(text, voice: Assistants.personal.liveVoice) }
                try await Task.sleep(nanoseconds: UInt64(after * 1_000_000_000))
                let cut = Date()
                speech.stop()
                _ = try? await speaking.value
                print(String(format: "first audio %.2fs; stop returned control in %.0f ms (cut at %.2fs)",
                             speech.firstAudioLatency ?? -1, Date().timeIntervalSince(cut) * 1000,
                             cut.timeIntervalSince(started)))
                return speech.isSpeaking ? 1 : 0
            }
        } catch {
            FileHandle.standardError.write(Data("voice test failed: \(error.localizedDescription)\n".utf8))
            return 1
        }
        return 2
    }
}
