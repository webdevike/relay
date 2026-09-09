// Seams between the three RelayCore areas. The transport (Server/ClientSession) only ever talks to
// these protocols; Input/ and Agents/ implement them; the app target wires concrete instances.
// Keep them narrow: adding a method here is an architecture decision, not a convenience.

import Foundation
import RelayProtocol

/// Consumes ephemeral trackpad input. Called on the transport's queue, must be cheap and never
/// block; drop rather than queue when behind. Never invoked with events older than the batch that
/// carried them: the transport already discards stale batches from a previous connection.
public protocol InputSink: AnyObject {
    func handle(_ events: [InputEvent])
}

/// Types into whatever has keyboard focus on the Mac. Throws `AckError` (e.g. `.accessibilityDenied`).
public protocol TextInjecting: AnyObject {
    func insert(_ text: String) throws
    func press(_ key: KeyName) throws
}

public protocol AccessibilityChecking: AnyObject {
    /// AXIsProcessTrusted() right now (never cached; TCC grants change while the app runs).
    var isTrusted: Bool { get }
    /// Ask the system to show the Accessibility prompt / open the pane.
    func requestAccess()
}

public enum AgentProviderChange: Sendable, Equatable {
    /// The session list (or any session's status/activity) changed; read `sessions` again.
    case sessions
    /// New messages were appended to a conversation the transport may be subscribed to.
    case conversation(sessionId: String, appended: [AgentMessage])
}

/// One coding-agent integration (Claude Code first). Provider-independent by construction: the
/// transport never sees anything but `AgentSession` / `AgentMessage`.
public protocol AgentProvider: AnyObject {
    /// Stable id used as `AgentSession.provider` ("claude-code").
    var id: String { get }
    /// Whether the provider is installed and observing (drives `MacState.agentsAvailable`).
    var isAvailable: Bool { get }
    /// Begin observing. Idempotent.
    func start()
    /// Current sessions, newest activity first. Cheap: a cached array.
    var sessions: [AgentSession] { get }
    /// Full conversation, oldest first; nil when the session is unknown.
    func conversation(for sessionId: String) -> [AgentMessage]?
    /// Deliver `text` as the next user turn. Throws `AckError` (`.agentNotFound`, `.agentCannotRespond`, ...).
    func reply(sessionId: String, text: String) async throws
    /// Set by the transport; invoked on any queue.
    var onChange: ((AgentProviderChange) -> Void)? { get set }
}
