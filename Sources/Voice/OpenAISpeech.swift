import AVFoundation
import Foundation

/// Text to speech through POST /v1/audio/speech with response_format "pcm" (24 kHz mono s16le),
/// streamed: every sentence is requested up front (in parallel), played in order, and audio starts
/// as soon as the first chunk of the first sentence arrives.
final class OpenAISpeech: VoiceOutput, @unchecked Sendable {
    /// Play through the speakers. Tests can turn this off.
    var playback = true
    /// When set, each speak() also writes what was spoken to this WAV file.
    var recordTo: URL?
    var voice = VoiceConfig.voice
    var model = VoiceConfig.speechModel
    var style = VoiceConfig.speechStyle
    /// Seconds from speak() to the first audio chunk of the last utterance.
    private(set) var firstAudioLatency: TimeInterval?

    private let lock = VoiceLock()
    private var generation = 0
    private var speaking = false
    private var producers: [Task<Void, Never>] = []
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var pending = 0
    private var finishedScheduling = false
    private var drainWaiter: CheckedContinuation<Void, Never>?
    private var failure: Error?

    var isSpeaking: Bool { lock.lock(); defer { lock.unlock() }; return speaking }

    func speak(_ text: String) async throws {
        stop()
        let spoken = OpenAISpeech.prepare(text)
        guard !spoken.isEmpty else { return }
        let key = try VoiceConfig.apiKey()
        let started = Date()

        lock.lock()
        generation += 1
        let mine = generation
        speaking = true
        failure = nil
        pending = 0
        finishedScheduling = false
        lock.unlock()

        // Every sentence starts fetching now; playback consumes them in order.
        var streams: [AsyncStream<Data>] = []
        var tasks: [Task<Void, Never>] = []
        for sentence in OpenAISpeech.sentences(of: spoken) {
            let (stream, continuation) = AsyncStream<Data>.makeStream()
            streams.append(stream)
            tasks.append(Task { [self] in await produce(sentence, key: key, into: continuation, generation: mine) })
        }
        lock.lock(); producers = tasks; lock.unlock()

        defer {
            lock.lock()
            if generation == mine { speaking = false }
            lock.unlock()
        }

        if playback { try startEngine() }
        var recorded = Data()
        var gotFirst = false
        outer: for stream in streams {
            for await chunk in stream {
                if !isCurrent(mine) { break outer }
                if !gotFirst {
                    gotFirst = true
                    firstAudioLatency = Date().timeIntervalSince(started)
                }
                if recordTo != nil { recorded.append(chunk) }
                if playback { schedule(chunk) }
            }
        }
        lock.lock()
        if generation == mine { finishedScheduling = true }
        let waiting = pending > 0 && generation == mine
        lock.unlock()
        if waiting {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                lock.lock()
                if pending == 0 || generation != mine {
                    lock.unlock()
                    continuation.resume()
                } else {
                    drainWaiter = continuation
                    lock.unlock()
                }
            }
        }
        if isCurrent(mine) { teardownEngine() }
        if let url = recordTo, !recorded.isEmpty { try OpenAISpeech.writeWAV(recorded, to: url) }
        lock.lock()
        let error = (generation == mine) ? failure : nil
        lock.unlock()
        if let error, !gotFirst { throw error }
    }

    /// Instant: halts the player, cancels downloads, releases a pending speak().
    func stop() {
        lock.lock()
        generation += 1                 // invalidates the running speak()
        speaking = false
        let tasks = producers
        producers = []
        let waiter = drainWaiter
        drainWaiter = nil
        pending = 0
        lock.unlock()
        tasks.forEach { $0.cancel() }
        teardownEngine()
        waiter?.resume()
    }

    // MARK: network

    private func produce(_ sentence: String, key: String, into out: AsyncStream<Data>.Continuation, generation mine: Int) async {
        defer { out.finish() }
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/audio/speech")!, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "model": model, "voice": voice, "input": sentence,
            "instructions": style, "response_format": "pcm",
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else {
                var data = Data()
                for try await byte in bytes { data.append(byte); if data.count > 400 { break } }
                let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let message = ((json?["error"] as? [String: Any])?["message"] as? String)
                    ?? String(decoding: data, as: UTF8.self)
                record(VoiceError.http(status, message), generation: mine)
                return
            }
            var buffer = Data()
            for try await byte in bytes {
                buffer.append(byte)
                if buffer.count >= 4800 {                       // 100 ms
                    out.yield(buffer)
                    buffer.removeAll(keepingCapacity: true)
                }
            }
            if buffer.count >= 2 { out.yield(buffer.prefix(buffer.count & ~1)) }
        } catch is CancellationError {
        } catch {
            if (error as? URLError)?.code != .cancelled { record(error, generation: mine) }
        }
    }

    private func record(_ error: Error, generation mine: Int) {
        lock.lock()
        if generation == mine, failure == nil { failure = error }
        lock.unlock()
    }

    private func isCurrent(_ mine: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return generation == mine
    }

    // MARK: playback

    private func startEngine() throws {
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        let format = AVAudioFormat(standardFormatWithSampleRate: VoiceConfig.sampleRate, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: format)
        do { try engine.start() } catch { throw VoiceError.micUnavailable("audio output: \(error.localizedDescription)") }
        player.play()
        lock.lock()
        self.engine = engine
        self.player = player
        lock.unlock()
    }

    private func schedule(_ pcm: Data) {
        lock.lock()
        let player = self.player
        lock.unlock()
        let frames = pcm.count / 2
        guard let player, frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: player.outputFormat(forBus: 0), frameCapacity: AVAudioFrameCount(frames)),
              let out = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for i in 0..<frames { out[i] = Float(samples[i]) / 32768 }
        }
        lock.lock(); pending += 1; lock.unlock()
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            if self.pending > 0 { self.pending -= 1 }
            let done = self.pending == 0 && self.finishedScheduling
            let waiter = done ? self.drainWaiter : nil
            if done { self.drainWaiter = nil }
            self.lock.unlock()
            waiter?.resume()
        }
    }

    private func teardownEngine() {
        lock.lock()
        let engine = self.engine
        let player = self.player
        self.engine = nil
        self.player = nil
        lock.unlock()
        player?.stop()
        engine?.stop()
    }

    // MARK: text

    /// Plain speakable text: no markdown, no dashes the voice would read oddly.
    static func prepare(_ text: String) -> String {
        var out = text
        for (from, to) in [("\u{2014}", ", "), ("\u{2013}", ", "), ("`", ""), ("*", ""), ("#", ""), ("_", " ")] {
            out = out.replacingOccurrences(of: from, with: to)
        }
        return out.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Splits at sentence ends; fragments under 14 characters join the next sentence.
    static func sentences(of text: String) -> [String] {
        var result: [String] = []
        var current = ""
        let chars = Array(text)
        for (i, ch) in chars.enumerated() {
            current.append(ch)
            let end = ".!?".contains(ch) && (i + 1 == chars.count || chars[i + 1] == " ")
            if end, current.count >= 14 {
                result.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            }
        }
        let rest = current.trimmingCharacters(in: .whitespaces)
        if !rest.isEmpty { result.append(rest) }
        return result
    }

    static func writeWAV(_ pcm: Data, to url: URL) throws {
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: VoiceConfig.sampleRate,
            AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        ]
        let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatInt16, interleaved: true)
        let frames = AVAudioFrameCount(pcm.count / 2)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: PCMConverter.outFormat, frameCapacity: frames),
              let dest = buffer.int16ChannelData?[0] else { return }
        buffer.frameLength = frames
        pcm.withUnsafeBytes { raw in
            if let base = raw.baseAddress { memcpy(dest, base, Int(frames) * 2) }
        }
        try file.write(from: buffer)
    }
}
