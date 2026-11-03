import Foundation

/// One accessibility element parsed back out of `ScreenContext.axLines`
/// (`Role "label" [x,y,w,h] note`), in screenshot pixels.
struct AXElement {
    let role: String
    let label: String
    let frame: CGRect
    let line: String

    var center: CGPoint { CGPoint(x: frame.midX, y: frame.midY) }

    private static let pattern = try! NSRegularExpression(
        pattern: #"^(\w+)(?: "(.*)")? \[(-?\d+),(-?\d+),(\d+),(\d+)\]"#)

    static func parse(_ line: String) -> AXElement? {
        let ns = line as NSString
        guard let m = pattern.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        func group(_ i: Int) -> String? {
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
        guard let role = group(1), let x = Double(group(3) ?? ""), let y = Double(group(4) ?? ""),
              let w = Double(group(5) ?? ""), let h = Double(group(6) ?? "") else { return nil }
        return AXElement(role: role, label: group(2) ?? "", frame: CGRect(x: x, y: y, width: w, height: h), line: line)
    }
}

/// What Jev (TypeSafe System One) chose.
struct JevPick {
    let element: AXElement
    let confidence: Double?
    let ms: Int
}

/// Jev client: AX tree text only, no screenshot. Same request shape as tools/jev-bench.ts.
enum Jev {
    private static let endpoint = URL(string: "https://api.typesafe.ai/v1/systemone")!
    static let timeout: TimeInterval = 1.5
    /// Below this Jev probability the pick is not trusted and Terra takes over.
    static let minConfidence = 0.5

    private static let apiKey: String? = {
        if let key = ProcessInfo.processInfo.environment["TYPESAFE_API_KEY"], !key.isEmpty { return key }
        let path = ProcessInfo.processInfo.environment["RELAY_BUDDY_JEV_ENV_FILE"] ?? "/Users/ike/Eva/secrets/jev.env"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        for raw in text.split(separator: "\n") where raw.hasPrefix("TYPESAFE_API_KEY=") {
            return raw.dropFirst("TYPESAFE_API_KEY=".count).trimmingCharacters(in: CharacterSet(charactersIn: "\"' \r"))
        }
        return nil
    }()

    static var isAvailable: Bool { apiKey != nil }

    /// Elements Jev may choose from: labelled, big enough to point at (same filter as the bench).
    static func candidates(_ lines: [String]) -> [AXElement] {
        Array(lines.compactMap(AXElement.parse).filter { !$0.label.isEmpty && $0.frame.width >= 2 && $0.frame.height >= 2 }.prefix(254))
    }

    /// Asks Jev which element answers `question`. nil: Jev said none, failed, or timed out.
    /// Never throws: callers fall back to Terra.
    static func pick(question: String, app: String, title: String, elements: [AXElement], instruction: String? = nil) async -> JevPick? {
        guard let key = apiKey, !elements.isEmpty else { return nil }
        let started = Date()
        var criteria: [String: String] = [:]
        for (i, e) in elements.enumerated() { criteria["e\(i)"] = e.line }
        criteria["none"] = "No element on screen is the thing the user is asking about."
        let tree = (elements.map(\.line) + [criteria["none"]!]).joined(separator: "\n")
        let body: [String: Any] = [
            "model": "jev-latest",
            "state": ["question": question, "window": ["app": app, "title": title, "accessibility_tree": tree]],
            "questions": ["target": [
                "type": "choice",
                "instructions": instruction ?? "The user asked `question` about this window. Which single element should a pointer be placed on to show them the answer? Pick the control itself (button, icon, menu item, row), not the thing it acts on.",
                "criteria": criteria,
            ]],
        ]
        var request = URLRequest(url: endpoint, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        request.httpBody = data
        do {
            let (reply, response) = try await URLSession.shared.data(for: request)
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: reply) as? [String: Any],
                  let target = (json["answers"] as? [String: Any])?["target"] as? [String: Any],
                  let choice = target["choice"] as? String else {
                Log.info("jev: bad reply (\((response as? HTTPURLResponse)?.statusCode ?? 0)) in \(ms)ms")
                return nil
            }
            guard choice != "none", choice.hasPrefix("e"), let index = Int(choice.dropFirst()), elements.indices.contains(index) else {
                Log.info("jev: none in \(ms)ms")
                return nil
            }
            var confidence: Double?
            if let probs = target["probabilities"] as? [String: Any] {
                confidence = (probs[choice] as? NSNumber)?.doubleValue
            }
            return JevPick(element: elements[index], confidence: confidence, ms: ms)
        } catch {
            Log.info("jev: failed in \(Int(Date().timeIntervalSince(started) * 1000))ms: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: Intent

    private static let stop: Set<String> = ["the", "a", "an", "my", "button", "tool", "icon", "menu", "option", "tab",
                                            "setting", "settings", "item", "panel", "to", "of", "in", "on", "for"]

    static func tokens(_ text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { !stop.contains($0) }
    }

    private static let findPattern = try! NSRegularExpression(
        pattern: #"^\s*(?:(?:hey )?buddy[, ]+)?(?:where(?:'s| is| are| can i find| do i find| would i find)|find|locate|show me|point (?:to|at|me to)|take me to)\s+(?:the |my |a |an )?(.+?)[\s?.!]*$"#,
        options: .caseInsensitive)

    /// The control the question names ("where is Wi-Fi" -> "Wi-Fi"), or nil for how-to, vague
    /// or do-it questions, which need Terra's judgment.
    static func namedTarget(in question: String) -> String? {
        let ns = question as NSString
        guard let m = findPattern.firstMatch(in: question, range: NSRange(location: 0, length: ns.length)),
              m.numberOfRanges > 1 else { return nil }
        let target = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
        let words = tokens(target)
        guard !words.isEmpty, words.count <= 4, target.split(separator: " ").count <= 6 else { return nil }
        let lowered = target.lowercased()
        // Questions that are really "how do I ..." or about a screen region, not one control.
        for vague in ["how", "why", "what", "everything", "anything", "this", "that", "here", "all "] where lowered.hasPrefix(vague) {
            return nil
        }
        return target
    }

    /// True when the element's label names the target: every target word appears in the label,
    /// or the whole label is the target.
    static func labelMatches(_ label: String, target: String) -> Bool {
        let want = tokens(target)
        let have = Set(tokens(label))
        guard !want.isEmpty, !have.isEmpty else { return false }
        return want.allSatisfy(have.contains) || Set(want).isSuperset(of: have)
    }

    /// A tree with enough labelled controls to be worth asking Jev (Blender's viewport and
    /// toolbars expose only a few menu items).
    static func hasUsableTree(_ lines: [String]) -> Bool {
        lines.compactMap(AXElement.parse).filter { !$0.label.isEmpty }.count >= 8
    }

    // MARK: Chores

    /// Resolves a chore click to an AX element's center (screenshot pixels), or nil when no
    /// labelled element confidently matches `description` (callers then use the model's point).
    static func resolveClick(description: String, context: ScreenContext) async -> AXElement? {
        let elements = candidates(context.axLines)
        guard elements.count >= 3 else { return nil }
        let pick = await pick(
            question: description, app: context.target.name, title: context.windowTitle, elements: elements,
            instruction: "The assistant must click one control to do this: `question`. Which single element should be clicked? Pick the control itself, not the thing it acts on.")
        guard let pick, pick.confidence.map({ $0 >= minConfidence }) ?? true,
              !Set(tokens(description)).isDisjoint(with: Set(tokens(pick.element.label))) else { return nil }
        return pick.element
    }
}
