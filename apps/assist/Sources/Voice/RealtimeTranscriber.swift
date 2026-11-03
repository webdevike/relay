import Foundation

/// One streaming transcription turn over wss://api.openai.com/v1/realtime?intent=transcription.
/// append() PCM as it arrives (before or after the socket is ready: early audio is queued in
/// order), then finish() to commit and get the final text. Partial text arrives through onPartial.
final class RealtimeTranscriber: @unchecked Sendable {
    var onPartial: ((String) -> Void)?

    private let key: String
    private let model: String
    private let keywords: [String]
    private let prompt: String?
    private let session = URLSession(configuration: .ephemeral)
    private var socket: URLSessionWebSocketTask?

    private let lock = VoiceLock()
    private var outbox: AsyncStream<String>.Continuation?
    private var partial = ""
    private var finalText: String?
    private var failure: Error?
    private var appendedBytes = 0
    private var waiter: CheckedContinuation<Void, Never>?
    private var closed = false

    init(key: String, model: String = VoiceConfig.transcribeModel, keywords: [String] = [], prompt: String? = nil) {
        self.key = key
        self.model = model
        self.keywords = keywords
        self.prompt = prompt
    }

    /// Opens the socket and configures the session. Sends are queued, so callers may append()
    /// right after calling this without awaiting it.
    func connect() {
        var request = URLRequest(url: URL(string: "wss://api.openai.com/v1/realtime?intent=transcription")!)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        let (stream, continuation) = AsyncStream<String>.makeStream()
        lock.lock()
        socket = task
        outbox = continuation
        lock.unlock()
        task.resume()

        var transcription: [String: Any] = ["model": model]
        if !keywords.isEmpty { transcription["keywords"] = keywords }
        if let prompt { transcription["prompt"] = prompt }
        if model == "gpt-live-transcribe" {
            transcription["languages"] = ["en"]
            transcription["delay"] = "low"
        } else {
            transcription["language"] = "en"
        }
        enqueue([
            "type": "session.update",
            "session": [
                "type": "transcription",
                "audio": ["input": [
                    "format": ["type": "audio/pcm", "rate": 24000],
                    "transcription": transcription,
                    "turn_detection": NSNull(),
                ]],
            ] as [String: Any],
        ])

        // One sender keeps frames strictly ordered.
        Task { [weak self] in
            for await text in stream {
                guard let self, let socket = self.currentSocket() else { return }
                do { try await socket.send(.string(text)) } catch { self.fail(error); return }
            }
        }
        Task { [weak self] in await self?.receiveLoop() }
    }

    func append(_ pcm: Data) {
        guard !pcm.isEmpty else { return }
        lock.lock(); appendedBytes += pcm.count; lock.unlock()
        enqueue(["type": "input_audio_buffer.append", "audio": pcm.base64EncodedString()])
    }

    /// Commits the turn and waits (up to `timeout`) for the final transcript.
    func finish(timeout: TimeInterval = 15) async throws -> String {
        lock.lock()
        let bytes = appendedBytes
        lock.unlock()
        // The service rejects commits under 100 ms of audio.
        guard bytes >= Int(VoiceConfig.sampleRate * 2 * 0.1) else { close(); return "" }
        enqueue(["type": "input_audio_buffer.commit"])

        let deadline = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            self?.wake()
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            if finalText != nil || failure != nil {
                lock.unlock()
                continuation.resume()
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
        deadline.cancel()
        lock.lock()
        let text = finalText ?? partial
        let error = failure
        lock.unlock()
        close()
        if let error, text.isEmpty { throw error }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func close() {
        lock.lock()
        closed = true
        let task = socket
        let box = outbox
        outbox = nil
        lock.unlock()
        box?.finish()
        task?.cancel(with: .normalClosure, reason: nil)
        wake()
    }

    // MARK: internals

    private func currentSocket() -> URLSessionWebSocketTask? {
        lock.lock(); defer { lock.unlock() }
        return socket
    }

    private func enqueue(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        lock.lock()
        let box = outbox
        lock.unlock()
        box?.yield(text)
    }

    private func wake() {
        lock.lock()
        let continuation = waiter
        waiter = nil
        lock.unlock()
        continuation?.resume()
    }

    private func fail(_ error: Error) {
        lock.lock()
        let already = closed
        if failure == nil, !already { failure = error }
        lock.unlock()
        if !already { wake() }
    }

    private func receiveLoop() async {
        while let socket = currentSocket() {
            let message: URLSessionWebSocketTask.Message
            do { message = try await socket.receive() } catch { fail(error); return }
            guard case .string(let text) = message,
                  let json = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { continue }
            switch json["type"] as? String {
            case "conversation.item.input_audio_transcription.delta":
                guard let delta = json["delta"] as? String else { continue }
                lock.lock()
                partial += delta
                let current = partial
                lock.unlock()
                if let onPartial {
                    DispatchQueue.main.async { onPartial(current) }
                }
            case "conversation.item.input_audio_transcription.completed":
                lock.lock()
                finalText = (json["transcript"] as? String) ?? partial
                lock.unlock()
                wake()
            case "conversation.item.input_audio_transcription.failed":
                let message = ((json["error"] as? [String: Any])?["message"] as? String) ?? "transcription failed"
                fail(VoiceError.transcription(message))
            case "error":
                let message = ((json["error"] as? [String: Any])?["message"] as? String) ?? "unknown error"
                fail(VoiceError.transcription(message))
            default:
                break
            }
        }
    }
}
