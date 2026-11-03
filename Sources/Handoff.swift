import ApplicationServices
import Cocoa

/// "Let's get started on this", "hand this off", "look into this", "make a ticket for this", "remind me
/// about this": bundles what is on screen (app, window title, ticket key, URL, selected text, a screenshot,
/// the last thing the assistant explained) and hands it to an assistant through the plumbing Eva already
/// has. Messages go to her Relay thread with `.omp/tools/eva-thread.ts` (the host's /assistant/say);
/// reminders are written to Nova's followups.json the way Nova keeps them. Nothing is created in Linear
/// here: a ticket is a draft request to Astra, who needs Isaac's yes before creating it.
enum Handoff {
    enum Kind: String {
        case start, investigate, handoff, ticket, remind
    }

    struct Intent {
        let kind: Kind
        /// "remind me about this tomorrow at 3pm": when; nil for the other kinds.
        let when: Date?
        /// The words include "test": the receiving assistant is told it is a TEST and to take no action.
        let test: Bool
    }

    private static let patterns: [(Kind, String)] = [
        (.remind, #"\bremind me\b"#),
        (.ticket, #"\b(?:make|create|file|open|draft|write)\s+(?:a|an)\s+(?:ticket|issue|linear (?:ticket|issue))\b"#),
        (.start, #"\b(?:let'?s|lets)\s+(?:get started|start|begin|work)\s+on\s+(?:this|it)\b|\bget started on (?:this|it)\b"#),
        (.investigate, #"\b(?:look into|dig into|investigate|check into)\s+(?:this|it)\b"#),
        (.handoff, #"\bhand (?:this|it) off\b|\bhand off (?:this|it)\b|\bpass (?:this|it) (?:on|along|to)\b|\bsend (?:this|it) to\b"#),
    ]

    static func intent(in question: String) -> Intent? {
        for (kind, pattern) in patterns where question.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil {
            let test = question.range(of: #"\btest\b"#, options: [.regularExpression, .caseInsensitive]) != nil
            return Intent(kind: kind, when: kind == .remind ? reminderTime(question, now: Date()) : nil, test: test)
        }
        return nil
    }

    /// "in 2 hours", "in 30 minutes", "tonight", "tomorrow (at 3pm)", "at 4:30pm"; default tomorrow 9:00.
    static func reminderTime(_ text: String, now: Date, calendar: Calendar = .current) -> Date {
        let lower = text.lowercased()
        func match(_ pattern: String) -> [String]? {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let m = regex.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)) else { return nil }
            return (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: lower).map { String(lower[$0]) } ?? "" }
        }
        if let m = match(#"\bin (\d+) (minute|min|hour|hr)s?\b"#), let n = Double(m[1]) {
            return now.addingTimeInterval(n * (m[2].hasPrefix("h") ? 3600 : 60))
        }
        var day = calendar.startOfDay(for: now)
        let tomorrow = lower.contains("tomorrow")
        if tomorrow { day = calendar.date(byAdding: .day, value: 1, to: day)! }
        var hour = 9, minute = 0
        if let m = match(#"\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b"#), var h = Int(m[1]) {
            if m[3] == "pm", h < 12 { h += 12 }
            if m[3] == "am", h == 12 { h = 0 }
            if m[3].isEmpty, h < 8 { h += 12 }  // "at 3" means the afternoon
            hour = h
            minute = Int(m[2]) ?? 0
        } else if lower.contains("tonight") {
            hour = 20
        } else if !tomorrow {
            // No time given: tomorrow morning.
            day = calendar.date(byAdding: .day, value: 1, to: day)!
        }
        var date = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? now.addingTimeInterval(86_400)
        if date <= now { date = calendar.date(byAdding: .day, value: 1, to: date)! }
        return date
    }

    // MARK: Context

    struct Bundle {
        let app: String
        let bundleID: String
        let windowTitle: String
        let ticket: String?
        let url: String?
        let selection: String?
        let screenshot: String?
        let lastExplanation: String?
    }

    static func gather(target: TargetApp, lastExplanation: String?) async -> Bundle {
        let context = try? await Capture.capture(target)
        var shot: String?
        if let jpeg = context?.jpeg, !jpeg.isEmpty {
            let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/RelayBuddy/handoffs")
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd'T'HH-mm-ss"
            let file = dir.appendingPathComponent("\(f.string(from: Date())).jpg")
            if (try? jpeg.write(to: file)) != nil { shot = file.path }
        }
        let title = context?.windowTitle ?? Capture.frontWindow(pid: target.pid)?.title ?? ""
        let (selection, url) = await Task.detached { (selectedText(pid: target.pid), documentURL(pid: target.pid)) }.value
        let ticket = title.range(of: LinearHook.keyPattern, options: .regularExpression).map { String(title[$0]) }
        return Bundle(app: target.name, bundleID: target.bundleID, windowTitle: title, ticket: ticket,
                      url: url ?? title.range(of: #"https?://\S+"#, options: .regularExpression).map { String(title[$0]) },
                      selection: selection, screenshot: shot, lastExplanation: lastExplanation)
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    /// The selected text in the app's focused element, via AX; nil without Accessibility or a selection.
    static func selectedText(pid: pid_t) -> String? {
        guard AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.3)
        guard let focused = attribute(app, kAXFocusedUIElementAttribute),
              let text = attribute(focused as! AXUIElement, kAXSelectedTextAttribute) as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : String(trimmed.prefix(1500))
    }

    /// The focused window's document URL (browsers and document apps expose AXDocument).
    static func documentURL(pid: pid_t) -> String? {
        guard AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.3)
        guard let window = attribute(app, kAXFocusedWindowAttribute),
              let doc = attribute(window as! AXUIElement, kAXDocumentAttribute) as? String,
              doc.hasPrefix("http") else { return nil }
        return doc
    }

    // MARK: Message

    static func message(_ intent: Intent, said: String, bundle b: Bundle) -> String {
        let ask: String
        switch intent.kind {
        case .start: ask = "He wants to get started on this now: start the work (open a session if it needs one) and tell him what you kicked off."
        case .investigate: ask = "Look into this and tell him what you find. Don't change anything yet."
        case .handoff: ask = "He's handing this to you: take it from here and tell him the plan."
        case .ticket: ask = "Draft a Linear ticket for this (title, description, acceptance criteria) and send him the draft. Do NOT create it in Linear until he says yes."
        case .remind: ask = "Reminder for him."
        }
        var lines = ["[Relay Assist handoff]" + (intent.test ? " TEST" : "") + " Isaac said \"\(said)\" while looking at \(b.app)."]
        lines.append(intent.test ? "This is a TEST of Relay Assist's handoff: acknowledge it in one line and take no other action." : ask)
        lines.append("Window: \"\(b.windowTitle)\" (\(b.bundleID))")
        if let t = b.ticket { lines.append("Ticket: \(t)") }
        if let u = b.url { lines.append("URL: \(u)") }
        if let s = b.selection { lines.append("Selected text: \"\(s)\"") }
        if let e = b.lastExplanation { lines.append("Last thing Relay Assist explained there: \"\(e)\"") }
        if let p = b.screenshot { lines.append("Screenshot: \(p)") }
        return lines.joined(separator: "\n")
    }

    // MARK: Delivery

    private static let eva = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Eva")
    private static let bun = ["/Users/ike/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].first {
        FileManager.default.isExecutableFile(atPath: $0)
    }

    /// Posts `text` to the agent's Relay thread through eva-thread.ts; returns its one-line verdict.
    static func tell(agent: String, _ text: String) async -> (ok: Bool, detail: String) {
        guard let bun else { return (false, "bun not found") }
        let tool = eva.appendingPathComponent(".omp/tools/eva-thread.ts").path
        return await Task.detached { () -> (Bool, String) in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: bun)
            p.arguments = [tool, "--agent", agent, text]
            p.currentDirectoryURL = eva
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            do { try p.run() } catch { return (false, error.localizedDescription) }
            p.waitUntilExit()
            let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (p.terminationStatus == 0 && out.hasPrefix("delivered"), out)
        }.value
    }

    /// Appends a pending follow-up to `agent`'s followups.json ({"at": ISO-8601 UTC, "text": ...}, as Nova keeps them).
    static func remind(agent: String, at date: Date, text: String) -> Bool {
        let url = eva.appendingPathComponent("work/eva/agents/\(agent)/followups.json")
        var list = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [[String: Any]]) ?? []
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        list.append(["at": f.string(from: date), "text": text])
        guard let data = try? JSONSerialization.data(withJSONObject: list, options: [.prettyPrinted, .withoutEscapingSlashes]) else { return false }
        return (try? data.write(to: url, options: .atomic)) != nil
    }

    static func describe(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let time = DateFormatter()
        time.dateFormat = calendar.component(.minute, from: date) == 0 ? "h a" : "h:mm a"
        let t = time.string(from: date)
        if calendar.isDate(date, inSameDayAs: now) { return "today at \(t)" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) { return "tomorrow at \(t)" }
        let day = DateFormatter()
        day.dateFormat = "EEEE"
        return "\(day.string(from: date)) at \(t)"
    }
}
