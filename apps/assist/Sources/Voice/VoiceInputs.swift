import AVFoundation
import Foundation

/// Microphone input: AVAudioEngine tap, converted to 24 kHz PCM, streamed to the transcriber.
/// The app bundle needs NSMicrophoneUsageDescription in Info.plist or macOS kills it on first use.
final class MicVoiceInput: VoiceInput {
    var onPartial: ((String) -> Void)?
    var onLevel: ((Float) -> Void)?
    var keywords: [String] = []
    var prompt: String? = "A user asking a helper where to find tools, buttons and menus in a desktop app."

    private let engine = AVAudioEngine()
    private var transcriber: RealtimeTranscriber?
    private var lastLevel = Date.distantPast
    private var running = false

    static var permissionGranted: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }

    /// Asks macOS for microphone access when undecided. Returns whether it is granted.
    static func requestPermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }

    func start() async throws {
        guard !running else { return }
        guard await MicVoiceInput.requestPermission() else { throw VoiceError.micDenied }
        let key = try VoiceConfig.apiKey()
        let transcriber = RealtimeTranscriber(key: key, keywords: keywords, prompt: prompt)
        transcriber.onPartial = { [weak self] text in self?.onPartial?(text) }
        transcriber.connect()
        self.transcriber = transcriber

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, let converter = PCMConverter(from: format) else {
            transcriber.close()
            throw VoiceError.micUnavailable("no input device")
        }
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let pcm = converter.convert(buffer)
            guard !pcm.isEmpty else { return }
            self.transcriber?.append(pcm)
            let now = Date()
            if now.timeIntervalSince(self.lastLevel) > 0.05 {
                self.lastLevel = now
                let level = PCMConverter.level(of: pcm)
                let callback = onLevel; DispatchQueue.main.async { callback?(level) }
            }
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            transcriber.close()
            throw VoiceError.micUnavailable(error.localizedDescription)
        }
        running = true
    }

    func stop() async throws -> String {
        guard running, let transcriber else { return "" }
        halt()
        return try await transcriber.finish()
    }

    func cancel() {
        halt()
        transcriber?.close()
        transcriber = nil
    }

    private func halt() {
        guard running else { return }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

/// Test input: feeds an audio file (wav, aiff, m4a, mp3) through the same transcriber the mic uses.
/// start() streams the whole file; stop() commits and returns the transcript.
final class FileVoiceInput: VoiceInput {
    var onPartial: ((String) -> Void)?
    var onLevel: ((Float) -> Void)?
    let url: URL
    /// Pace the upload like a live mic (true) or send it all at once (false, faster tests).
    var realtime = false
    var keywords: [String] = []
    var prompt: String?
    private var transcriber: RealtimeTranscriber?

    init(url: URL) { self.url = url }

    func start() async throws {
        let key = try VoiceConfig.apiKey()
        let pcm = try PCMConverter.load(file: url)
        let transcriber = RealtimeTranscriber(key: key, keywords: keywords, prompt: prompt)
        transcriber.onPartial = { [weak self] text in self?.onPartial?(text) }
        transcriber.connect()
        self.transcriber = transcriber
        let chunk = Int(VoiceConfig.sampleRate * 2 * 0.1)       // 100 ms
        var offset = 0
        while offset < pcm.count {
            let part = pcm.subdata(in: offset..<min(offset + chunk, pcm.count))
            transcriber.append(part)
            let level = PCMConverter.level(of: part)
            let callback = onLevel; DispatchQueue.main.async { callback?(level) }
            offset += chunk
            if realtime { try await Task.sleep(nanoseconds: 100_000_000) }
        }
    }

    func stop() async throws -> String {
        guard let transcriber else { return "" }
        return try await transcriber.finish()
    }

    func cancel() {
        transcriber?.close()
        transcriber = nil
    }
}
