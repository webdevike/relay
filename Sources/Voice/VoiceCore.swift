import AVFoundation
import Foundation

// Voice for Buddy: hold a key to talk (speech to text), Buddy answers out loud (text to speech).
// Everything here is self-contained so the app only needs VoiceController (VoiceController.swift).

/// Speech to text for one push-to-talk turn.
protocol VoiceInput: AnyObject {
    /// Live transcript so far, full text each time (not a delta). Called on the main queue.
    var onPartial: ((String) -> Void)? { get set }
    /// Input loudness 0...1 about 20 times a second while recording, for a level meter. Main queue.
    var onLevel: ((Float) -> Void)? { get set }
    /// Begin capturing and streaming. Throws VoiceError.micDenied etc.
    func start() async throws
    /// Stop capturing, wait for the final transcript, return it (trimmed, may be empty).
    func stop() async throws -> String
    /// Abort without a result (user dismissed).
    func cancel()
}

/// Text to speech.
protocol VoiceOutput: AnyObject {
    var isSpeaking: Bool { get }
    /// Speaks `text` in `voice` (an assistant's liveVoice, e.g. "marin"); returns when playback
    /// finished or `stop()` was called. First audio starts as soon as the first sentence arrives.
    func speak(_ text: String, voice: String) async throws
    /// Silence immediately (well under 100 ms) and make a pending `speak` return.
    func stop()
}

enum VoiceError: LocalizedError {
    case noKey
    case micDenied
    case micUnavailable(String)
    case http(Int, String)
    case transcription(String)
    case badAudio(String)

    var errorDescription: String? {
        switch self {
        case .noKey: return "No OpenAI key found (OPENAI_API_KEY)."
        case .micDenied:
            return "I can't hear you yet. Allow Relay Assist in System Settings > Privacy & Security > Microphone."
        case .micUnavailable(let why): return "The microphone isn't available: \(why)"
        case .http(let code, let message): return "The voice service failed (\(code)): \(message)"
        case .transcription(let why): return "I couldn't transcribe that: \(why)"
        case .badAudio(let why): return "I couldn't read that audio: \(why)"
        }
    }
}

enum VoiceConfig {
    /// Streaming speech to text over the Realtime API (transcription session). Alternative: gpt-transcribe.
    static let transcribeModel = ProcessInfo.processInfo.environment["RELAY_BUDDY_STT_MODEL"] ?? "gpt-live-transcribe"
    /// Speech API. OpenAI deprecates gpt-4o-mini-tts on 2027-01-06; swap the model here (and the
    /// transport in OpenAISpeech) when moving to the Realtime API.
    static let speechModel = ProcessInfo.processInfo.environment["RELAY_BUDDY_TTS_MODEL"] ?? "gpt-4o-mini-tts"
    static let speechStyle = """
    Warm, friendly and upbeat, like a patient friend sitting next to the user and showing them \
    where to click. Natural short sentences, a brisk but unhurried pace, a smile in the voice. \
    Never robotic, never salesy.
    """
    /// Both services use 24 kHz mono signed 16-bit PCM.
    static let sampleRate: Double = 24000

    static func apiKey() throws -> String {
        if let key = ProcessInfo.processInfo.environment["OPENAI_API_KEY"], !key.isEmpty { return key }
        let path = ProcessInfo.processInfo.environment["RELAY_BUDDY_ENV_FILE"] ?? "/Users/ike/Eva/secrets/openai.env"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { throw VoiceError.noKey }
        for raw in text.split(separator: "\n") {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("export ") { line = String(line.dropFirst(7)) }
            guard line.hasPrefix("OPENAI_API_KEY=") else { continue }
            let value = line.dropFirst("OPENAI_API_KEY=".count).trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
            if !value.isEmpty { return value }
        }
        throw VoiceError.noKey
    }
}

/// Converts any PCM buffer to 24 kHz mono Int16 little-endian bytes.
final class PCMConverter {
    static let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: VoiceConfig.sampleRate,
                                         channels: 1, interleaved: true)!
    private let converter: AVAudioConverter
    private let ratio: Double

    init?(from format: AVAudioFormat) {
        guard let converter = AVAudioConverter(from: format, to: PCMConverter.outFormat) else { return nil }
        self.converter = converter
        self.ratio = VoiceConfig.sampleRate / format.sampleRate
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> Data {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 256
        guard let out = AVAudioPCMBuffer(pcmFormat: PCMConverter.outFormat, frameCapacity: capacity) else { return Data() }
        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData?[0] else { return Data() }
        return Data(bytes: samples, count: Int(out.frameLength) * 2)
    }

    /// Reads a whole audio file (wav, aiff, m4a, mp3, caf ...) as 24 kHz mono PCM16.
    static func load(file url: URL) throws -> Data {
        let file: AVAudioFile
        do { file = try AVAudioFile(forReading: url) } catch { throw VoiceError.badAudio("\(url.lastPathComponent): \(error.localizedDescription)") }
        guard let converter = PCMConverter(from: file.processingFormat) else {
            throw VoiceError.badAudio("unsupported format \(file.processingFormat)")
        }
        var pcm = Data()
        while file.framePosition < file.length {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 8192) else { break }
            try file.read(into: buffer)
            if buffer.frameLength == 0 { break }
            pcm.append(converter.convert(buffer))
        }
        return pcm
    }

    /// 0...1 loudness of Int16 samples, shaped so normal speech reads around 0.3 to 0.8.
    static func level(of pcm: Data) -> Float {
        let count = pcm.count / 2
        guard count > 0 else { return 0 }
        var sum: Double = 0
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for i in 0..<count { let v = Double(samples[i]) / 32768; sum += v * v }
        }
        let rms = (sum / Double(count)).squareRoot()
        let db = 20 * log10(max(rms, 1e-5))        // -100 ... 0
        return Float(min(1, max(0, (db + 50) / 45)))
    }
}

/// NSLock without the async-context diagnostics: every critical section here is short and never
/// suspends, so holding it across no `await` is guaranteed by construction.
final class VoiceLock {
    private let inner = NSLock()
    func lock() { inner.lock() }
    func unlock() { inner.unlock() }
}
