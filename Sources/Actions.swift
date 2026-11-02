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
        return UndoRecord(title: title) {
            (try? await CuaDriver.call("hotkey", ["pid": Int(pid), "keys": ["cmd", "z"]])) != nil
        }
    }

    private static func generic(_ action: BuddyAction, context: ScreenContext) async throws {
        let pid = Int(context.target.pid)
        let window = Int(context.windowID)
        switch action.kind {
        case .click:
            guard let p = action.point else { throw HookError.failed("no point to click") }
            // cua-driver clicks in window-local screenshot pixels at the display's backing scale.
            let backing = Capture.backingScale(for: context.windowFrame)
            try await CuaDriver.call("click", ["pid": pid, "window_id": window,
                                              "x": Double(p.x / context.scale * backing),
                                              "y": Double(p.y / context.scale * backing)])
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
            try await CuaDriver.call("invoke_menu", ["pid": pid, "window_id": window, "path": path])
        case .blenderPython:
            throw HookError.failed("Blender's add-on is not reachable for that")
        }
    }
}
