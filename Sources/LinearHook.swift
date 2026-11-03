import Cocoa

/// Read-only Linear integration: finds the issue key in the window title, fetches the whole
/// ticket in one GraphQL call (cached ~60 s per issue) and hands it to Brain as hook state.
/// It never writes to Linear: every do() action is refused.
struct LinearHook: AppHook {
    static let bundleID = "com.linear"
    let name = "Linear"
    let pid: pid_t

    static let timeout: TimeInterval = 1.5
    static let cacheTTL: TimeInterval = 60
    static let keyPattern = #"\b[A-Z][A-Z0-9]*-\d+\b"#

    private static let cacheLock = NSLock()
    private static var cache: [String: (at: Date, text: String)] = [:]

    var promptNotes: String {
        """
        Linear hook: the live state above is the ticket (or the lack of one) read through Linear's API. \
        For questions about a ticket ("what is this", "what's blocking this", "catch me up", "what's the next step") \
        answer from that data, in plain words, as ONE say() call of 2 to 5 short lines separated by newlines \
        (at most about 450 characters in total, each line under 90 characters): what it asks for, its status and \
        what blocks it, who it is waiting on, the next step. Say "ENG-1234" style keys only when useful. Blockers \
        are the "Blocked by" items that are not Done; if none, say nothing blocks it. Pointing is optional: add one \
        point or highlight only when a part of the screen helps; always finish with done() in the same turn. If the \
        state says no issue is open, say so in the first line, then summarize the issues visible in the list in the \
        screenshot and accessibility elements in one or two lines. If the API data is missing, answer from the screen \
        only and say it is from the screen.
        Never state anything the data does not show. Buddy is read-only in Linear: never call do(), and if asked \
        to comment, change status, assign or edit, say in one line that you only read tickets.
        """
    }

    func sceneState() async -> String? {
        let started = Date()
        let title = Capture.frontWindow(pid: pid)?.title ?? ""
        guard let key = Self.issueKey(in: title) else {
            Log.info("linear hook: no issue key in window title \"\(title)\"")
            return "No issue is open on screen (window title \"\(title)\"): the user is in a list, board or other view."
        }
        if let hit = Self.cached(key) {
            Log.info(String(format: "linear hook: %@ from cache (%.0f ms)", key, Date().timeIntervalSince(started) * 1000))
            return hit
        }
        do {
            let text = try await Self.fetch(key)
            Self.store(key, text)
            Log.info(String(format: "linear hook: fetched %@ in %.0f ms (%d chars)", key, Date().timeIntervalSince(started) * 1000, text.count))
            return text
        } catch {
            Log.info(String(format: "linear hook: fetch %@ failed after %.0f ms: %@, screen only", key,
                            Date().timeIntervalSince(started) * 1000, error.localizedDescription))
            return "Issue on screen: \(key) (window title \"\(title)\"). The Linear API did not answer in time, so there is no ticket data: answer from the screen only."
        }
    }

    func snapshot() async -> String? { nil }

    func run(_ action: BuddyAction) async throws -> Bool {
        throw HookError.failed("I only read Linear tickets, I don't change anything there.")
    }

    func undo(to snapshot: String) async -> Bool { false }
    func check(_ expression: String) async -> Bool? { nil }

    // MARK: Key

    static func issueKey(in title: String) -> String? {
        guard let r = title.range(of: keyPattern, options: .regularExpression) else { return nil }
        return String(title[r])
    }

    private static func cached(_ key: String) -> String? {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        guard let hit = cache[key], Date().timeIntervalSince(hit.at) < cacheTTL else { return nil }
        return hit.text
    }

    private static func store(_ key: String, _ text: String) {
        cacheLock.lock()
        cache[key] = (Date(), text)
        cacheLock.unlock()
    }

    // MARK: API

    private static let apiKey: String? = {
        if let key = ProcessInfo.processInfo.environment["LINEAR_API_KEY"], !key.isEmpty { return key }
        let path = ProcessInfo.processInfo.environment["RELAY_BUDDY_LINEAR_ENV_FILE"] ?? "/Users/ike/Eva/secrets/linear.env"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        for raw in text.split(separator: "\n") {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("export ") { line = String(line.dropFirst(7)) }
            guard line.hasPrefix("LINEAR_API_KEY=") else { continue }
            return line.dropFirst("LINEAR_API_KEY=".count).trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
        }
        return nil
    }()

    private static let query = """
    query($id:String!){issue(id:$id){identifier title description priorityLabel updatedAt \
    state{name type} assignee{name} creator{name} labels{nodes{name}} project{name} cycle{number name} \
    parent{identifier title state{name}} children{nodes{identifier title state{name}}} \
    relations{nodes{type relatedIssue{identifier title state{name}}}} \
    inverseRelations{nodes{type issue{identifier title state{name}}}} \
    comments(last:15){nodes{user{name} createdAt body}} \
    attachments{nodes{title subtitle url sourceType metadata}}}}
    """

    private static func fetch(_ key: String) async throws -> String {
        guard let token = apiKey else { throw HookError.unreachable("no LINEAR_API_KEY") }
        var request = URLRequest(url: URL(string: "https://api.linear.app/graphql")!, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue(token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["query": query, "variables": ["id": key]])
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard status == 200, let issue = (json?["data"] as? [String: Any])?["issue"] as? [String: Any] else {
            throw HookError.failed("Linear API \(status)")
        }
        return render(issue)
    }

    // MARK: Render

    private static func trimmed(_ s: String?, _ limit: Int) -> String {
        let t = (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count <= limit ? t : String(t.prefix(limit)) + " [...]"
    }

    private static func name(_ value: Any?, _ key: String = "name") -> String? {
        (value as? [String: Any])?[key] as? String
    }

    private static func nodes(_ value: Any?) -> [[String: Any]] {
        ((value as? [String: Any])?["nodes"] as? [[String: Any]]) ?? []
    }

    private static func line(_ issue: [String: Any]?) -> String {
        guard let issue else { return "" }
        return "\(issue["identifier"] as? String ?? "?") \(trimmed(issue["title"] as? String, 90)) [\(name(issue["state"]) ?? "?")]"
    }

    static func render(_ i: [String: Any]) -> String {
        var out: [String] = []
        out.append("Ticket \(i["identifier"] as? String ?? ""): \(i["title"] as? String ?? "")")
        var facts = ["Status: \(name(i["state"]) ?? "?")"]
        if let p = i["priorityLabel"] as? String { facts.append("Priority: \(p)") }
        facts.append("Assignee: \(name(i["assignee"]) ?? "unassigned")")
        if let c = name(i["creator"]) { facts.append("Created by: \(c)") }
        if let u = i["updatedAt"] as? String { facts.append("Updated: \(u.prefix(10))") }
        out.append(facts.joined(separator: " | "))
        let labels = nodes(i["labels"]).compactMap { $0["name"] as? String }
        if !labels.isEmpty { out.append("Labels: " + labels.joined(separator: ", ")) }
        if let p = name(i["project"]) { out.append("Project: \(p)") }
        if let c = i["cycle"] as? [String: Any] {
            out.append("Cycle: \(c["name"] as? String ?? "#\(c["number"] ?? "?")")")
        }
        if let parent = i["parent"] as? [String: Any] { out.append("Parent: " + line(parent)) }
        let children = nodes(i["children"])
        if !children.isEmpty { out.append("Sub-issues:\n" + children.map { "- " + line($0) }.joined(separator: "\n")) }

        var blocks: [String] = [], blockedBy: [String] = [], related: [String] = []
        for r in nodes(i["relations"]) {
            let l = line(r["relatedIssue"] as? [String: Any])
            switch r["type"] as? String { case "blocks": blocks.append(l); case "related": related.append(l); default: related.append("(\(r["type"] ?? "")) " + l) }
        }
        for r in nodes(i["inverseRelations"]) {
            let l = line(r["issue"] as? [String: Any])
            switch r["type"] as? String { case "blocks": blockedBy.append(l); case "related": related.append(l); default: related.append("(\(r["type"] ?? "")) " + l) }
        }
        out.append("Blocked by:" + (blockedBy.isEmpty ? " none" : "\n" + blockedBy.map { "- " + $0 }.joined(separator: "\n")))
        out.append("Blocks:" + (blocks.isEmpty ? " none" : "\n" + blocks.map { "- " + $0 }.joined(separator: "\n")))
        if !related.isEmpty { out.append("Related:\n" + related.prefix(6).map { "- " + $0 }.joined(separator: "\n")) }

        let attachments = nodes(i["attachments"])
        if !attachments.isEmpty {
            out.append("Attachments:")
            for a in attachments.prefix(8) {
                var s = "- \(a["sourceType"] as? String ?? "link"): \(trimmed(a["title"] as? String, 80)) \(a["url"] as? String ?? "")"
                if let sub = a["subtitle"] as? String, !sub.isEmpty { s += " (\(sub))" }
                if let meta = a["metadata"] as? [String: Any] {
                    let keep = ["status", "state", "draft", "merged", "reviews", "checks", "isDraft", "number"]
                    let bits = keep.compactMap { k in meta[k].map { "\(k)=\($0)" } }
                    if !bits.isEmpty { s += " {" + bits.joined(separator: ", ") + "}" }
                }
                out.append(s)
            }
        }
        let desc = trimmed(i["description"] as? String, 3000)
        out.append("Description:\n" + (desc.isEmpty ? "(empty)" : desc))

        let comments = nodes(i["comments"])
        if comments.isEmpty {
            out.append("Comments: none")
        } else {
            out.append("Last \(comments.count) comments, oldest first:")
            for c in comments {
                let who = name(c["user"]) ?? "someone"
                let day = (c["createdAt"] as? String).map { String($0.prefix(10)) } ?? ""
                out.append("- \(who), \(day): " + trimmed(c["body"] as? String, 500).replacingOccurrences(of: "\n", with: " "))
            }
        }
        return out.joined(separator: "\n")
    }
}
