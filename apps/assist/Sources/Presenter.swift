import Cocoa

// `RelayBuddy --present`: Relay Assist's overlay and voice as a driven presentation layer.
// A host (Relay Desktop's @computer agent) writes one JSON command per line on stdin and reads one JSON
// event per line on stdout. Coordinates are global display points, top-left origin (CoreGraphics space).
// No hotkey, no prompt bubble, no status item, and no quit handoff: the resident Assist keeps running.

// MARK: Protocol

struct PresenterError: Error, Equatable {
    let message: String
}

enum PresenterCommand: Equatable {
    case assistant(id: String)
    case point(id: Int, rect: CGRect, caption: String, speak: String?, step: Int?, of: Int?)
    case click(id: Int, x: Double, y: Double, caption: String)
    case caption(id: Int, text: String, speak: Bool)
    case hide
    case quit

    /// Parses one stdin line. Pure: no screen, no voice.
    static func parse(_ line: String) -> Result<PresenterCommand, PresenterError> {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let json = object as? [String: Any] else {
            return .failure(PresenterError(message: "not a JSON object"))
        }
        guard let op = json["op"] as? String else { return .failure(PresenterError(message: "missing op")) }
        do {
            switch op {
            case "assistant":
                return .success(.assistant(id: try string(json, "id", op: op)))
            case "point":
                guard let rect = json["rect"] as? [String: Any] else { throw PresenterError(message: "point: missing rect") }
                let x = try number(rect, "x", op: "point rect"), y = try number(rect, "y", op: "point rect")
                let w = try number(rect, "w", op: "point rect"), h = try number(rect, "h", op: "point rect")
                guard w >= 0, h >= 0 else { throw PresenterError(message: "point rect: w and h must not be negative") }
                let box = CGRect(x: x, y: y, width: w, height: h)
                return .success(.point(id: try integer(json, "id", op: op), rect: box,
                                       caption: try optionalString(json, "caption", op: op) ?? "",
                                       speak: try optionalString(json, "speak", op: op),
                                       step: try optionalInteger(json, "step", op: op),
                                       of: try optionalInteger(json, "of", op: op)))
            case "click":
                return .success(.click(id: try integer(json, "id", op: op), x: try number(json, "x", op: op),
                                       y: try number(json, "y", op: op),
                                       caption: try optionalString(json, "caption", op: op) ?? ""))
            case "caption":
                let speak: Bool
                if let raw = json["speak"] {
                    guard let flag = raw as? Bool, isBool(raw) else { throw PresenterError(message: "caption: speak must be true or false") }
                    speak = flag
                } else {
                    speak = false
                }
                return .success(.caption(id: try integer(json, "id", op: op), text: try string(json, "text", op: op), speak: speak))
            case "hide": return .success(.hide)
            case "quit": return .success(.quit)
            default: return .failure(PresenterError(message: "unknown op \"\(op)\""))
            }
        } catch let error as PresenterError {
            return .failure(error)
        } catch {
            return .failure(PresenterError(message: "\(error)"))
        }
    }

    private static func isBool(_ value: Any) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    private static func string(_ json: [String: Any], _ key: String, op: String) throws -> String {
        guard let value = json[key] else { throw PresenterError(message: "\(op): missing \(key)") }
        guard let text = value as? String else { throw PresenterError(message: "\(op): \(key) must be a string") }
        return text
    }

    private static func optionalString(_ json: [String: Any], _ key: String, op: String) throws -> String? {
        guard json[key] != nil, !(json[key] is NSNull) else { return nil }
        return try string(json, key, op: op)
    }

    private static func number(_ json: [String: Any], _ key: String, op: String) throws -> Double {
        guard let value = json[key] else { throw PresenterError(message: "\(op): missing \(key)") }
        guard let n = value as? NSNumber, !isBool(value), n.doubleValue.isFinite else {
            throw PresenterError(message: "\(op): \(key) must be a number")
        }
        return n.doubleValue
    }

    private static func integer(_ json: [String: Any], _ key: String, op: String) throws -> Int {
        let n = try number(json, key, op: op)
        guard n == n.rounded(), abs(n) < 1e15 else { throw PresenterError(message: "\(op): \(key) must be an integer") }
        return Int(n)
    }

    private static func optionalInteger(_ json: [String: Any], _ key: String, op: String) throws -> Int? {
        guard json[key] != nil, !(json[key] is NSNull) else { return nil }
        return try integer(json, key, op: op)
    }
}

enum PresenterEvent {
    case ready
    case landed(id: Int)
    case spoken(id: Int)
    case esc
    case error(String)

    /// One compact JSON line, keys sorted so the output is stable.
    var line: String {
        let object: [String: Any]
        switch self {
        case .ready: object = ["ev": "ready"]
        case .landed(let id): object = ["ev": "landed", "id": id]
        case .spoken(let id): object = ["ev": "spoken", "id": id]
        case .esc: object = ["ev": "esc"]
        case .error(let message): object = ["ev": "error", "message": message]
        }
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}

// MARK: App

@MainActor
final class PresenterApp: NSObject, NSApplicationDelegate {
    private let overlay = OverlayController()
    private let voice = VoiceController()
    /// RELAY_BUDDY_SPEAK=0 keeps it quiet: every `spoken` event then fires at once.
    private let speaks = ProcessInfo.processInfo.environment["RELAY_BUDDY_SPEAK"] != "0"
    private var assistant = Assistants.personal
    private var avatarApplied = false
    private var started = false
    /// The op whose speech is playing; `spoken` fires when it ends or is cut off.
    private var speakingID: Int?
    /// Ops whose `landed` has not been printed yet.
    private var awaitingLanded: Set<Int> = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN)
        Log.info("Relay Assist presenter up. assistants=\(Assistants.all.map { "\($0.title)(\($0.liveVoice))" }.joined(separator: ","))")
        overlay.dismissOnClick = false
        overlay.onEscape = { [weak self] in
            guard let self else { return }
            Log.info("present: esc")
            self.voice.stopSpeaking()
            self.flushLanded()
            self.emit(.esc)
        }
        voice.onSpeaking = { [weak self] on in
            guard !on, let self, let id = self.speakingID else { return }
            self.speakingID = nil
            self.emit(.spoken(id: id))
        }
        voice.onError = { error in Log.info("present: speech error: \(error.localizedDescription)") }
        applyAssistant(assistant)
        // Ready once the avatars are drawn or loaded (a cold cache can take a few seconds; do not wait for ever).
        Assistants.prepareAvatars { [weak self] in self?.start() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in self?.start() }
    }

    private func start() {
        guard !started else { return }
        started = true
        applyAssistant(assistant)
        emit(.ready)
        let thread = Thread {
            while let line = readLine(strippingNewline: true) {
                DispatchQueue.main.async { MainActor.assumeIsolated { PresenterApp.shared?.handle(line) } }
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { PresenterApp.shared?.quit() } }
        }
        thread.name = "presenter-stdin"
        thread.start()
    }

    nonisolated(unsafe) static var shared: PresenterApp?

    // MARK: Commands

    private func handle(_ line: String) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        switch PresenterCommand.parse(trimmed) {
        case .failure(let error):
            Log.info("present: bad line (\(error.message)): \(trimmed.prefix(200))")
            emit(.error(error.message))
        case .success(let command):
            run(command)
        }
    }

    private func run(_ command: PresenterCommand) {
        switch command {
        case .assistant(let id):
            assistant = Assistants.named(id) ?? Assistants.personal
            applyAssistant(assistant)
            Log.info("present: assistant \(assistant.title) (\(assistant.liveVoice))")
        case .point(let id, let rect, let caption, let text, let step, _):
            flushLanded()
            refreshAvatar()
            let step1 = PlanStep(kind: .highlight(rect), label: caption, box: rect)
            awaitingLanded.insert(id)
            // `hold`, not `stay`: up until the next op the same way, without Assist's "· staying" name tag.
            overlay.perform(Plan(steps: [step1], say: caption), context: Self.context(), stay: false, hold: true, stepNumber: step) { [weak self] in
                self?.emitLanded(id)
            }
            if let text, !text.isEmpty { speak(id: id, text) }
        case .click(let id, let x, let y, let caption):
            flushLanded()
            refreshAvatar()
            awaitingLanded.insert(id)
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.overlay.chore(at: CGPoint(x: x, y: y), context: Self.context(), caption: caption)
                self.emitLanded(id)
            }
        case .caption(let id, let text, let speakIt):
            flushLanded()
            refreshAvatar()
            overlay.perform(Plan(steps: [], say: text), context: Self.context(), stay: false, hold: true)
            emit(.landed(id: id))
            if speakIt { speak(id: id, text) }
        case .hide:
            flushLanded()
            overlay.dismiss(fast: false)
        case .quit:
            quit()
        }
    }

    func quit() {
        flushLanded()
        overlay.dismiss(fast: true)
        voice.stopSpeaking()
        // Let the 0.12 s fade finish and any final events flush, then leave.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { exit(0) }
    }

    // MARK: Pieces

    private func applyAssistant(_ next: Assistant) {
        overlay.setAssistant(next)
        avatarApplied = Assistants.avatar(for: next) != nil
    }

    /// The avatar PNG can arrive after the assistant was chosen; pick it up on the next op.
    private func refreshAvatar() {
        if !avatarApplied { applyAssistant(assistant) }
    }

    private func speak(id: Int, _ text: String) {
        guard speaks else { return emit(.spoken(id: id)) }
        // A new line replaces the one playing; VoiceController does not report the cut-off one.
        if let old = speakingID { emit(.spoken(id: old)) }
        speakingID = id
        voice.speak(text, voice: assistant.liveVoice)
    }

    private func emitLanded(_ id: Int) {
        guard awaitingLanded.remove(id) != nil else { return }
        emit(.landed(id: id))
    }

    /// A newer op replaced the one still gliding: report it now so the host never waits on it.
    private func flushLanded() {
        for id in awaitingLanded.sorted() { emit(.landed(id: id)) }
        awaitingLanded.removeAll()
    }

    /// Display points, global, top-left origin: the overlay's own conversions then pass them through unchanged.
    private static func context() -> ScreenContext {
        ScreenContext(target: TargetApp(pid: 0, name: "", bundleID: ""), windowTitle: "", windowFrame: .zero, windowID: 0,
                      jpeg: Data(), imageSize: NSScreen.main?.frame.size ?? .zero, scale: 1, axLines: [], backend: "present")
    }

    private func emit(_ event: PresenterEvent) {
        fputs(event.line + "\n", stdout)
        fflush(stdout)
    }
}
