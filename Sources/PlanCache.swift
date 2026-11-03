import Cocoa

/// Trailblazing: the first time Terra works out how to answer an ask, Buddy saves the plan by
/// meaning (labels, menu paths, Blender code, window-relative fractions), not by pixels. The
/// next identical ask in the same context replays it with no model call. Stored in
/// ~/.local/share/eva/buddy-plans.json.

/// A point or highlight, stored by meaning.
struct CachedStep: Codable {
    var kind: String            // "point" | "highlight"
    var label: String
    var role: String?
    /// Label of the AX element the point landed on at save time; nil when it hit none (icon toolbars).
    var axLabel: String?
    /// point: [x, y]; highlight: [x, y, w, h]; fractions of the screenshot size.
    var rel: [Double]
    /// Screenshot width / height at save time, to notice a window that changed shape.
    var aspect: Double
}

struct CachedAction: Codable {
    var kind: String
    var description: String
    var relPoint: [Double]?
    var code: String?
    var keys: [String]?
    var menuPath: [String]?
}

/// One turn of Terra's answer: a chore (announce + actions), or a caption with points.
struct CachedPhase: Codable {
    var say: String?
    var announce: String?
    var actions: [CachedAction] = []
    var steps: [CachedStep] = []
}

struct CachedPlan: Codable {
    var question: String
    var bundleID: String
    var version: String
    var fingerprint: String
    var phases: [CachedPhase]
    var savedAt: Date
    var hits: Int
}

enum PlanCache {
    static var enabled: Bool { ProcessInfo.processInfo.environment["RELAY_BUDDY_PLAN_CACHE"] != "off" }

    private static let url: URL = {
        if let path = ProcessInfo.processInfo.environment["RELAY_BUDDY_PLAN_FILE"] { return URL(fileURLWithPath: path) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/eva/buddy-plans.json")
    }()

    private struct Store: Codable { var entries: [String: CachedPlan] = [:] }

    private static func load() -> Store {
        guard let data = try? Data(contentsOf: url) else { return Store() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(Store.self, from: data)) ?? Store()
    }

    private static func write(_ store: Store) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(store) else { return }
        try? data.write(to: url, options: .atomic)
    }

    // MARK: Key

    static func normalize(_ question: String) -> String {
        var q = question.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        q = q.replacingOccurrences(of: #"^(hey )?buddy[, ]+"#, with: "", options: .regularExpression)
        q = q.replacingOccurrences(of: "where's", with: "where is").replacingOccurrences(of: "what's", with: "what is")
        q = q.replacingOccurrences(of: #"[^\p{L}\p{N} ]+"#, with: " ", options: .regularExpression)
        return q.split(separator: " ").joined(separator: " ")
    }

    static func version(of target: TargetApp) -> String {
        guard let url = NSRunningApplication(processIdentifier: target.pid)?.bundleURL,
              let info = Bundle(url: url)?.infoDictionary else { return "" }
        return (info["CFBundleShortVersionString"] as? String) ?? (info["CFBundleVersion"] as? String) ?? ""
    }

    /// Blender: mode + active object type from the hook. Others: window title with digits and ids stripped.
    static func fingerprint(context: ScreenContext, sceneState: String?, hook: AppHook?) -> String {
        if hook?.name == "Blender", let state = sceneState {
            var mode = "?", type = "none"
            for line in state.split(separator: "\n") {
                if line.hasPrefix("Mode: ") { mode = String(line.dropFirst(6)) }
                if line.hasPrefix("Active object: "), let open = line.firstIndex(of: "("), let close = line[open...].firstIndex(of: ")") {
                    type = String(line[line.index(after: open)..<close])
                }
            }
            return "blender:\(mode)|\(type)"
        }
        var title = context.windowTitle.lowercased()
        title = title.replacingOccurrences(of: #"[0-9a-f]{8}-[0-9a-f-]{27}"#, with: "", options: .regularExpression)
        title = title.replacingOccurrences(of: #"[0-9]+"#, with: "", options: .regularExpression)
        return "title:" + title.split(separator: " ").joined(separator: " ")
    }

    static func key(context: ScreenContext, question: String, fingerprint: String) -> String {
        [context.target.bundleID, version(of: context.target), normalize(question), fingerprint].joined(separator: "\u{1F}")
    }

    // MARK: Safety

    /// Only reversible chores, navigation, pointing and captions are saved.
    private static let unsafe = try! NSRegularExpression(
        pattern: #"\b(delete|remove|erase|trash|empty|save|quit|close|send|buy|purchase|pay|unlink|purge|clear|export|write|open_mainfile|read_homefile|subprocess|os\.|shutil|exec|eval|submit|install|uninstall|reset|format)\b|cmd.*(q|s|w|delete|backspace)|\b(delete|backspace|return|enter)\b"#,
        options: .caseInsensitive)

    static func isSafe(_ action: BuddyAction) -> Bool {
        let text = [action.description, action.code ?? "", (action.keys ?? []).joined(separator: " "),
                    (action.menuPath ?? []).joined(separator: " ")].joined(separator: "\n")
        return unsafe.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) == nil
    }

    // MARK: Record

    static func phase(from plan: Plan, context: ScreenContext) -> CachedPhase {
        var phase = CachedPhase(say: plan.say)
        let w = max(context.imageSize.width, 1), h = max(context.imageSize.height, 1)
        let elements = context.axLines.compactMap(AXElement.parse).filter { !$0.label.isEmpty }
        let limit = w * h * 0.3
        for step in plan.steps.prefix(3) {
            switch step.kind {
            case .point(let p):
                let hit = elements.filter { $0.frame.contains(p) && $0.frame.width * $0.frame.height < limit }
                    .min { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
                phase.steps.append(CachedStep(kind: "point", label: step.label, role: hit?.role, axLabel: hit?.label,
                                              rel: [Double(p.x / w), Double(p.y / h)], aspect: Double(w / h)))
            case .highlight(let r):
                let hit = elements.first { iou($0.frame, r) > 0.7 }
                phase.steps.append(CachedStep(kind: "highlight", label: step.label, role: hit?.role, axLabel: hit?.label,
                                              rel: [Double(r.minX / w), Double(r.minY / h), Double(r.width / w), Double(r.height / h)],
                                              aspect: Double(w / h)))
            }
        }
        return phase
    }

    /// A chore turn: nil when any action is outside the safe set.
    static func choresPhase(_ request: DoRequest, say: String?, context: ScreenContext) -> CachedPhase? {
        guard !request.coreStep, request.actions.allSatisfy(isSafe) else { return nil }
        let w = max(context.imageSize.width, 1), h = max(context.imageSize.height, 1)
        let actions = request.actions.prefix(6).map { a in
            CachedAction(kind: a.kind.rawValue, description: a.description,
                         relPoint: a.point.map { [Double($0.x / w), Double($0.y / h)] },
                         code: a.code, keys: a.keys, menuPath: a.menuPath)
        }
        return CachedPhase(say: say, announce: request.announce, actions: Array(actions))
    }

    private static func iou(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let i = a.intersection(b)
        guard !i.isNull else { return 0 }
        let inter = i.width * i.height
        return inter / (a.width * a.height + b.width * b.height - inter)
    }

    // MARK: Store

    static func lookup(_ key: String) -> CachedPlan? { load().entries[key] }

    static func save(_ key: String, _ plan: CachedPlan) {
        var store = load()
        store.entries[key] = plan
        write(store)
    }

    /// Deletes one entry; false when it was not there.
    @discardableResult
    static func remove(_ key: String) -> Bool {
        var store = load()
        guard store.entries.removeValue(forKey: key) != nil else { return false }
        write(store)
        return true
    }

    /// `--forget "<question>"`: deletes every entry for this question, in any app or context. Returns how many.
    static func forget(_ question: String) -> Int {
        var store = load()
        let wanted = normalize(question)
        let keys = store.entries.filter { $0.value.question == wanted }.map(\.key)
        keys.forEach { store.entries.removeValue(forKey: $0) }
        if !keys.isEmpty { write(store) }
        return keys.count
    }

    static func recordHit(_ key: String) {
        var store = load()
        store.entries[key]?.hits += 1
        write(store)
    }

    // MARK: Replay

    /// Re-resolves one cached step on the current screen; nil when it cannot be found.
    static func resolve(_ step: CachedStep, context: ScreenContext) -> PlanStep? {
        let w = context.imageSize.width, h = context.imageSize.height
        guard h > 0, abs(Double(w / h) / step.aspect - 1) < 0.1 else { return nil }
        let elements = context.axLines.compactMap(AXElement.parse)
        var expected = CGPoint(x: step.rel[0] * Double(w), y: step.rel[1] * Double(h))
        if step.kind == "highlight" {
            expected = CGPoint(x: (step.rel[0] + step.rel[2] / 2) * Double(w), y: (step.rel[1] + step.rel[3] / 2) * Double(h))
        }
        if let label = step.axLabel {
            let matches = elements.filter {
                $0.label.caseInsensitiveCompare(label) == .orderedSame && (step.role == nil || $0.role == step.role)
                    && $0.frame.width >= 2 && $0.frame.height >= 2
            }
            guard let best = matches.min(by: { dist($0.center, expected) < dist($1.center, expected) }) else { return nil }
            return PlanStep(kind: step.kind == "point" ? .point(best.center) : .highlight(best.frame), label: step.label)
        }
        if step.kind == "point" { return PlanStep(kind: .point(expected), label: step.label) }
        return PlanStep(kind: .highlight(CGRect(x: step.rel[0] * Double(w), y: step.rel[1] * Double(h),
                                               width: step.rel[2] * Double(w), height: step.rel[3] * Double(h))), label: step.label)
    }

    private static func dist(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }

    static func request(_ phase: CachedPhase, context: ScreenContext) -> DoRequest {
        let w = context.imageSize.width, h = context.imageSize.height
        let actions = phase.actions.compactMap { a -> BuddyAction? in
            guard let kind = BuddyAction.Kind(rawValue: a.kind) else { return nil }
            let point = a.relPoint.map { CGPoint(x: $0[0] * Double(w), y: $0[1] * Double(h)) }
            return BuddyAction(kind: kind, description: a.description, point: point, code: a.code, keys: a.keys, menuPath: a.menuPath)
        }
        return DoRequest(announce: phase.announce ?? "Done", coreStep: false, actions: actions)
    }
}
