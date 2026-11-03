import Cocoa

/// Asks that need no brain: "open ENG-6309" opens the Linear issue, "open PR 123" or a PR URL opens
/// the pull request in the default browser. Matching is local; nothing here writes anywhere.
enum Shortcut {
    case linear(key: String)
    case pullRequest(URL)
    /// "PR 123" in an eCard repo: gh resolves its URL (`resolve`).
    case pullRequestNumber(String, repo: String)

    static let linearWorkspace = ProcessInfo.processInfo.environment["RELAY_ASSIST_LINEAR_WORKSPACE"] ?? "ecard-systems"

    private static let openVerb = #"\b(?:open|show|go to|go|pull up|bring up|take me to|jump to|navigate to)\b"#
    private static let prURL = #"https?://github\.com/[\w.-]+/[\w.-]+/pull/\d+"#

    /// The shortcut for `question`, or nil for the normal path. `target` lends a repo to "PR 123"
    /// when the question names none (a GitHub page of an eCard repo in front).
    static func match(_ question: String, target: TargetApp?) -> Shortcut? {
        guard question.range(of: openVerb, options: [.regularExpression, .caseInsensitive]) != nil else { return nil }
        if let r = question.range(of: prURL, options: .regularExpression), let url = URL(string: String(question[r])) {
            return .pullRequest(url)
        }
        if let number = prNumber(in: question) {
            guard let repo = repo(in: question) ?? target.flatMap(repoInFront) else {
                Log.info("shortcut: PR \(number) names no eCard repo, normal path")
                return nil
            }
            return .pullRequestNumber(number, repo: repo)
        }
        if let r = question.range(of: LinearHook.keyPattern, options: .regularExpression) {
            return .linear(key: String(question[r]))
        }
        return nil
    }

    /// The PR's URL as gh reports it, or nil when gh has no such PR.
    static func resolve(_ number: String, repo: String) async -> URL? {
        guard let gh = EcardRepos.gh else { return nil }
        let out = await Task.detached {
            EcardRepos.run(gh, ["pr", "view", number, "-R", "\(EcardRepos.org)/\(repo)", "--json", "url", "-q", ".url"])
        }.value
        return out.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
    }

    private static func prNumber(in question: String) -> String? {
        for pattern in [#"\bPR\s*#?(\d+)\b"#, #"(?i)\bpull request\s*#?(\d+)\b"#] {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let m = regex.firstMatch(in: question, range: NSRange(question.startIndex..., in: question)),
                  let r = Range(m.range(at: 1), in: question) else { continue }
            return String(question[r])
        }
        return nil
    }

    private static func repo(in text: String) -> String? {
        AssistantRouter.ecardMarker(in: text).flatMap { $0.hasPrefix("repo:") ? String($0.dropFirst(5)) : nil }
    }

    /// "eCardSystems/<repo>" in the front window's title (GitHub pages title themselves that way).
    private static func repoInFront(_ target: TargetApp) -> String? {
        let title = AssistantRouter.windowTitle(pid: target.pid)
        let pattern = NSRegularExpression.escapedPattern(for: EcardRepos.org) + #"/([\w.-]+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
              let m = regex.firstMatch(in: title, range: NSRange(title.startIndex..., in: title)),
              let r = Range(m.range(at: 1), in: title) else { return nil }
        return String(title[r])
    }

    // MARK: Linear

    /// Opens the issue in the Linear app (its linear:// deep link), else on linear.app. Returns
    /// which one it used.
    static func openLinear(_ key: String) -> String {
        let deep = URL(string: "linear://\(linearWorkspace)/issue/\(key)")!
        if NSWorkspace.shared.urlForApplication(toOpen: deep) != nil {
            NSWorkspace.shared.open(deep)
            return "deep-link"
        }
        NSWorkspace.shared.open(URL(string: "https://linear.app/\(linearWorkspace)/issue/\(key)")!)
        return "web"
    }

    /// Linear, once its front window shows `key` (the app titles windows with the open issue).
    static func waitForLinear(showing key: String, timeout: TimeInterval) async -> TargetApp? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let app = NSRunningApplication.runningApplications(withBundleIdentifier: AssistantRouter.linearBundleID).first,
               AssistantRouter.windowTitle(pid: app.processIdentifier).contains(key) {
                return TargetApp(app)
            }
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
        return nil
    }

    /// The issue title from the Linear hook's (read-only, cached) ticket text: "Ticket KEY: title".
    static func issueTitle(_ key: String, pid: pid_t) async -> String? {
        guard let state = await LinearHook(pid: pid).sceneState(),
              let first = state.split(separator: "\n").first, first.hasPrefix("Ticket \(key): ") else { return nil }
        let title = first.dropFirst("Ticket \(key): ".count).trimmingCharacters(in: .whitespaces)
        return title.isEmpty ? nil : title
    }

    /// The on-screen element showing `title` (AX labels are flattened and cut at 57 characters):
    /// the tallest text match, so the issue's heading wins over the breadcrumb, and the page group
    /// Linear labels with the title is skipped.
    static func titleElement(_ title: String, in context: ScreenContext) -> AXElement? {
        let wanted = String(title.replacingOccurrences(of: "\"", with: "'").prefix(40)).lowercased()
        return Jev.candidates(context.axLines)
            .filter { $0.role != "Group" && $0.label.lowercased().hasPrefix(wanted) }
            .max { $0.frame.height < $1.frame.height }
    }
}
