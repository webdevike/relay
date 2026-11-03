import ApplicationServices
import Cocoa

/// One of Isaac's assistants, read from the registry Relay reads (`~/Eva/.omp/assistant/agents.json`,
/// see relay apps/linux/src/assistant/registry.ts). The hotkey cursor answers as one of them.
struct Assistant: Sendable {
    let id: String
    let title: String
    let profile: String?
    /// Relay's GPT-Live voice name for this agent (registry `liveVoice`, else "marin" like Relay's liveVoiceFor).
    let liveVoice: String
    let accentHex: String
    let paperHex: String
    /// The designed DiceBear portrait `{style, seed, options}` as JSON, drawn the way Relay draws it.
    let portraitJSON: String?

    @MainActor var accent: NSColor { NSColor(hex: accentHex) ?? Palette.accent }
    var paper: NSColor { NSColor(hex: paperHex) ?? .white }
}

enum Assistants {
    static let registryPath = ProcessInfo.processInfo.environment["RELAY_ASSIST_REGISTRY"]
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Eva/.omp/assistant/agents.json").path

    /// Registry agents in file order. Without a readable registry there is one unnamed assistant.
    static let all: [Assistant] = {
        guard let data = FileManager.default.contents(atPath: registryPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let agents = json["agents"] as? [[String: Any]], !agents.isEmpty else {
            Log.info("assistants: cannot read \(registryPath), answering as Relay Assist")
            return [Assistant(id: "assistant", title: "Relay Assist", profile: nil, liveVoice: "marin",
                              accentHex: "#f76707", paperHex: "#ffffff", portraitJSON: nil)]
        }
        return agents.compactMap { agent in
            guard let id = agent["id"] as? String, let title = agent["title"] as? String else { return nil }
            let avatar = agent["avatar"] as? [String: Any]
            let colors = avatar?["colors"] as? [String: Any]
            var portrait: String?
            if let avatar, avatar["seed"] is String {
                let drawn = avatar.filter { ["style", "seed", "options"].contains($0.key) }
                portrait = (try? JSONSerialization.data(withJSONObject: drawn, options: .sortedKeys)).flatMap { String(data: $0, encoding: .utf8) }
            }
            return Assistant(id: id, title: title, profile: agent["profile"] as? String,
                             liveVoice: agent["liveVoice"] as? String ?? "marin",
                             accentHex: colors?["accent"] as? String ?? "#f76707",
                             paperHex: colors?["paper"] as? String ?? "#ffffff", portraitJSON: portrait)
        }
    }()

    static func named(_ name: String) -> Assistant? {
        all.first { $0.id.caseInsensitiveCompare(name) == .orderedSame || $0.title.caseInsensitiveCompare(name) == .orderedSame }
    }

    /// Answers eCard work: the registry's work-profile agent (Astra).
    static var work: Assistant { all.first { $0.profile == "work" } ?? personal }
    /// Answers everything else: Nova, else the first personal agent.
    static var personal: Assistant { named("nova") ?? all.first { $0.profile == "personal" } ?? all[0] }

    // MARK: Avatars

    @MainActor private static var avatars: [String: NSImage] = [:]

    @MainActor static func avatar(for assistant: Assistant) -> NSImage? { avatars[assistant.id] }

    private static let cacheDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Caches/RelayBuddy/avatars")

    /// Loads each portrait PNG from the cache, drawing missing ones once with Relay's DiceBear
    /// generator (tools/render-avatar.ts, bundled into Resources) on the agent's paper disc.
    @MainActor static func prepareAvatars() {
        let agents = all
        Task.detached(priority: .utility) {
            for agent in agents {
                guard let portrait = agent.portraitJSON else { continue }
                let started = Date()
                let file = cacheDir.appendingPathComponent("\(agent.id)-\(fnv(portrait + agent.paperHex)).png")
                var source = "cache"
                if !FileManager.default.fileExists(atPath: file.path) {
                    source = "dicebear"
                    guard let svg = renderSVG(portrait), let png = discPNG(svg: svg, paper: agent.paper) else {
                        Log.info("assistants: could not draw \(agent.title)'s avatar")
                        continue
                    }
                    try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
                    try? png.write(to: file)
                }
                guard let image = NSImage(contentsOf: file) else { continue }
                Log.info(String(format: "assistants: %@ avatar from %@ in %.0fms (%@)", agent.title, source,
                                Date().timeIntervalSince(started) * 1000, file.lastPathComponent))
                await MainActor.run { avatars[agent.id] = image }
            }
        }
    }

    private static func renderSVG(_ portrait: String) -> String? {
        guard let script = ProcessInfo.processInfo.environment["RELAY_ASSIST_AVATAR_SCRIPT"]
                ?? Bundle.main.path(forResource: "render-avatar", ofType: "ts") else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: Navigator.bun)
        process.arguments = [script, portrait]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// The portrait on a round disc of its paper colour, 256 px, transparent outside the disc.
    private static func discPNG(svg: String, paper: NSColor) -> Data? {
        guard let image = NSImage(data: Data(svg.utf8)),
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 256, pixelsHigh: 256, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        let disc = NSBezierPath(ovalIn: NSRect(x: 0, y: 0, width: 256, height: 256))
        paper.setFill()
        disc.fill()
        disc.addClip()
        image.draw(in: NSRect(x: 18, y: 6, width: 220, height: 220))
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }

    private static func fnv(_ text: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in text.utf8 { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
        return String(hash, radix: 16)
    }
}

extension NSColor {
    convenience init?(hex: String) {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        self.init(srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
                  blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }
}

// MARK: - Routing

/// Who answers, by local rules only (no model call): a name in the question wins; then eCard
/// context on screen (Linear, or an eCard Slack workspace / GitHub org / repo in Slack, Chrome or
/// Arc); then eCard words in the question (an issue key, "PR", "pull request", an eCard repo);
/// otherwise the personal assistant.
enum AssistantRouter {
    struct Decision {
        let assistant: Assistant
        /// The question with an addressed name removed ("Nova, where is Wi-Fi" -> "where is Wi-Fi").
        let question: String
        let reason: String
    }

    static let linearBundleID = "com.linear"
    static let contextApps: [String: String] = [
        "com.tinyspeck.slackmacgap": "Slack", "com.google.Chrome": "Chrome", "company.thebrowser.Browser": "Arc",
    ]

    /// `stage`: "summon" (screen only, before the question) or "ask" (the final decision).
    static func route(_ question: String, target: TargetApp?, stage: String) -> Decision {
        let started = Date()
        let decision = decide(question, target: target)
        Log.info(String(format: "route=agent:%@ reason=%@ stage=%@ (%.0fms)", decision.assistant.id, decision.reason, stage,
                        Date().timeIntervalSince(started) * 1000))
        return decision
    }

    /// Who the bubble shows while the user types: the same rules as `route`, with the screen part
    /// (`screen`, decided at summon) reused so no AX read runs per keystroke. Not logged.
    static func live(_ text: String, screen: Decision) -> Assistant {
        if let (assistant, _) = addressed(text) { return assistant }
        if screen.assistant.id == Assistants.work.id || ecardQuestion(text) != nil { return Assistants.work }
        return Assistants.personal
    }

    static func decide(_ question: String, target: TargetApp?) -> Decision {
        if let (assistant, stripped) = addressed(question) {
            return Decision(assistant: assistant, question: stripped, reason: "addressed:\(assistant.title)")
        }
        if let target, let why = ecardContext(target) {
            return Decision(assistant: Assistants.work, question: question, reason: why)
        }
        if let why = ecardQuestion(question) {
            return Decision(assistant: Assistants.work, question: question, reason: why)
        }
        return Decision(assistant: Assistants.personal, question: question, reason: "default")
    }

    /// "Astra, ...", "hey Nova ...", "..., Nova?" or "ask Astra ...": that assistant, name removed.
    static func addressed(_ question: String) -> (Assistant, String)? {
        for assistant in Assistants.all {
            let name = NSRegularExpression.escapedPattern(for: assistant.title)
            let patterns = [
                #"^\s*(?:(?:hey|hi|ok|okay|ask)\s+)?"# + name + #"\b[\s,:;!.]*"#,
                #"[\s,]+"# + name + #"(?=[\s?.!]*$)"#,
                #"\b(?:hey|ask)\s+"# + name + #"\b[\s,:]*"#,
                #"\b"# + name + #",\s*"#,
            ]
            for pattern in patterns {
                guard let range = question.range(of: pattern, options: [.regularExpression, .caseInsensitive]) else { continue }
                var stripped = question
                stripped.replaceSubrange(range, with: range.lowerBound == question.startIndex ? "" : " ")
                stripped = stripped.trimmingCharacters(in: .whitespaces)
                    .replacingOccurrences(of: #"\s+([?.!])"#, with: "$1", options: .regularExpression)
                return (assistant, stripped.isEmpty ? question : stripped)
            }
        }
        return nil
    }

    /// Why the app in front is eCard work, or nil.
    static func ecardContext(_ target: TargetApp) -> String? {
        if target.bundleID == linearBundleID { return "app:Linear" }
        guard let app = contextApps[target.bundleID] else { return nil }
        let title = windowTitle(pid: target.pid)
        if let hit = ecardMarker(in: title) { return "\(app) title:\(hit)" }
        if let hit = ecardMarker(in: axText(pid: target.pid)) { return "\(app) ax:\(hit)" }
        return nil
    }

    /// Why the question is about eCard work, or nil.
    static func ecardQuestion(_ question: String) -> String? {
        if let r = question.range(of: #"\b[A-Z][A-Z0-9]*-\d+\b"#, options: .regularExpression) {
            return "question:issue-key \(question[r])"
        }
        if question.range(of: #"\bPRs?\b"#, options: .regularExpression) != nil { return "question:PR" }
        if question.range(of: "pull request", options: .caseInsensitive) != nil { return "question:pull-request" }
        if let hit = ecardMarker(in: question) { return "question:\(hit)" }
        return nil
    }

    /// "ecard" in any spelling (eCard Platform, ecardsystems, eCardSystems, ecard-systems) or an eCard repo name.
    static func ecardMarker(in text: String) -> String? {
        let lower = text.lowercased()
        if lower.contains("ecard") { return "ecard" }
        return EcardRepos.names.first { name in
            lower.range(of: #"(?<![\w-])"# + NSRegularExpression.escapedPattern(for: name) + #"(?![\w-])"#,
                        options: .regularExpression) != nil
        }.map { "repo:\($0)" }
    }

    /// The focused window's title (AX), else the WindowServer title.
    static func windowTitle(pid: pid_t) -> String {
        let app = AXUIElementCreateApplication(pid)
        if let window = attribute(app, kAXFocusedWindowAttribute) as! AXUIElement?,
           let title = attribute(window, kAXTitleAttribute) as? String, !title.isEmpty { return title }
        return Capture.frontWindow(pid: pid)?.title ?? ""
    }

    /// Text the focused window shows that a title may not: its document URL and text field values
    /// (a browser's address bar). Not static text: Arc's sidebar lists every open tab's title. Shallow walk, capped.
    static func axText(pid: pid_t) -> String {
        let app = AXUIElementCreateApplication(pid)
        guard let window = attribute(app, kAXFocusedWindowAttribute) as! AXUIElement? else { return "" }
        var out: [String] = []
        if let doc = attribute(window, kAXDocumentAttribute) as? String { out.append(doc) }
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var visited = 0
        while !queue.isEmpty, visited < 400 {
            let (element, depth) = queue.removeFirst()
            visited += 1
            let role = attribute(element, kAXRoleAttribute) as? String ?? ""
            if role == kAXTextFieldRole || role == "AXComboBox",
               let value = attribute(element, kAXValueAttribute) as? String, !value.isEmpty {
                out.append(value)
            }
            if role == "AXWebArea" { continue }
            guard depth < 10, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            queue.append(contentsOf: children.map { ($0, depth + 1) })
        }
        return out.joined(separator: "\n")
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
}

/// eCard's GitHub repos (org from `gh api user/orgs`), listed with gh once a day and cached.
/// Only hyphenated names count as markers: a bare word like "wordpress" says nothing about eCard.
enum EcardRepos {
    static let org = ProcessInfo.processInfo.environment["RELAY_ASSIST_ECARD_ORG"] ?? "eCardSystems"
    private static let file = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Caches/RelayBuddy/ecard-repos.txt")
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cached: [String] = load()

    static var names: [String] { lock.lock(); defer { lock.unlock() }; return cached }

    static let gh: String? = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].first { FileManager.default.isExecutableFile(atPath: $0) }

    private static func load() -> [String] {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").map { $0.lowercased() }.filter { $0.contains("-") }
    }

    /// Refreshes the list in the background when it is missing or older than a day.
    static func refreshIfStale() {
        let age = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
            .map { Date().timeIntervalSince($0) } ?? .infinity
        guard age > 86_400, let gh else { return }
        DispatchQueue.global(qos: .utility).async {
            let started = Date()
            guard let out = run(gh, ["repo", "list", org, "--limit", "500", "--json", "name", "--jq", ".[].name"]),
                  !out.isEmpty else { return Log.info("ecard repos: gh repo list \(org) failed") }
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? out.write(to: file, atomically: true, encoding: .utf8)
            let names = load()
            lock.lock(); cached = names; lock.unlock()
            Log.info(String(format: "ecard repos: %d from gh in %.0fms", names.count, Date().timeIntervalSince(started) * 1000))
        }
    }

    static func run(_ tool: String, _ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
