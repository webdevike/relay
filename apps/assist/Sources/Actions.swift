import Cocoa

/// One thing Buddy does for the user, from the model's do() call.
struct BuddyAction: Sendable {
    enum Kind: String, Sendable {
        case blenderPython = "blender_python"
        case click, key, menu
    }
    let kind: Kind
    let description: String
    /// The control this action corresponds to, in screenshot pixels (where the click trail goes).
    let point: CGPoint?
    let code: String?
    let keys: [String]?
    let menuPath: [String]?
}

/// A do() call: what to announce, whether it is the step being taught, and the actions.
struct DoRequest: Sendable {
    let announce: String
    let coreStep: Bool
    let actions: [BuddyAction]
}

/// How to take back what Buddy just did.
struct UndoRecord {
    let title: String
    let perform: @MainActor () async -> Bool
}

/// Users must ask for the taught step outright; chores never need permission.
enum DoPermission {
    private static let pattern =
        #"\b(do it|do this|do that|for me|you do|just do|go ahead|can you (do|make|add|bevel|apply|switch|open|turn|set)|please (do|make|add|apply))\b"#

    static func userAskedToDo(_ question: String) -> Bool {
        question.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }
}

enum Executor {
    /// Runs every action: through the app's hook when it owns the action, else through cua-driver.
    @MainActor
    static func run(_ request: DoRequest, context: ScreenContext, hook: AppHook?) async throws -> UndoRecord {
        let before = await hook?.snapshot()
        for action in request.actions {
            Log.info("do: \(action.kind.rawValue) \(action.description)")
            if let hook, try await hook.run(action) { continue }
            try await generic(action, context: context)
        }
        let title = request.announce
        if let hook, let before {
            return UndoRecord(title: title) { await hook.undo(to: before) }
        }
        let pid = context.target.pid
        let window = Int(context.windowID)
        return UndoRecord(title: title) {
            // Background shortcuts are often refused (Cmd+Z included), so use the Edit menu's live
            // "Undo <action>" item; its title changes with the last action.
            if let state = try? await CuaDriver.call("get_window_state", ["pid": Int(pid), "window_id": window]),
               let tree = state["tree_markdown"] as? String,
               let regex = try? NSRegularExpression(pattern: #"\[\d+\] AXMenuItem "(Undo[^"]*)""#),
               let match = regex.firstMatch(in: tree, range: NSRange(tree.startIndex..., in: tree)),
               let range = Range(match.range(at: 1), in: tree) {
                if (try? await CuaDriver.call("invoke_menu", ["pid": Int(pid), "window_id": window, "path": ["Edit", String(tree[range])]])) != nil {
                    return true
                }
            }
            return (try? await CuaDriver.call("hotkey", ["pid": Int(pid), "window_id": window, "keys": ["cmd", "z"]])) != nil
        }
    }

    private static func generic(_ action: BuddyAction, context: ScreenContext) async throws {
        let pid = Int(context.target.pid)
        let window = Int(context.windowID)
        switch action.kind {
        case .click:
            // Prefer the AX element Jev resolves from the action's description over the model's guess.
            var target = action.point
            let started = Date()
            if let element = await Jev.resolveClick(description: action.description, context: context) {
                Log.info(String(format: "chore: path=jev click \"%@\" in %.0fms (model point %@)", element.label,
                                Date().timeIntervalSince(started) * 1000, action.point.map { "\(Int($0.x)),\(Int($0.y))" } ?? "none"))
                target = element.center
            } else {
                Log.info(String(format: "chore: path=model-point click \"%@\" (no confident AX match, %.0fms)", action.description,
                                Date().timeIntervalSince(started) * 1000))
            }
            guard let p = target else { throw HookError.failed("no point to click") }
            try await clickWindow(p, context: context)
        case .key:
            let keys = (action.keys ?? []).map { $0.lowercased() }
            guard let key = keys.last else { throw HookError.failed("no key") }
            let modifiers = Array(keys.dropLast())
            if modifiers.isEmpty {
                try await CuaDriver.call("press_key", ["pid": pid, "window_id": window, "key": key])
            } else {
                try await CuaDriver.call("hotkey", ["pid": pid, "window_id": window, "keys": keys])
            }
        case .menu:
            guard let path = action.menuPath, !path.isEmpty else { throw HookError.failed("no menu path") }
            do {
                try await CuaDriver.call("invoke_menu", ["pid": pid, "window_id": window, "path": path])
            } catch {
                // The menu path did not resolve: find the item in the AX tree instead.
                guard let element = await Jev.resolveClick(description: path.joined(separator: " > "), context: context) else { throw error }
                Log.info("chore: path=jev menu fallback click \"\(element.label)\"")
                try await clickWindow(element.center, context: context)
            }
        case .blenderPython:
            throw HookError.failed("Blender's add-on is not reachable for that")
        }
    }

    /// cua-driver clicks in window-local screenshot pixels at the display's backing scale.
    private static func clickWindow(_ p: CGPoint, context: ScreenContext) async throws {
        let backing = Capture.backingScale(for: context.windowFrame)
        try await CuaDriver.call("click", ["pid": Int(context.target.pid), "window_id": Int(context.windowID),
                                          "x": Double(p.x / context.scale * backing),
                                          "y": Double(p.y / context.scale * backing)])
    }
}
