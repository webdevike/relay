// Relay wire protocol, v1. Swift mirror of packages/protocol/src/index.ts.
// Every frame is a JSON text frame with a `t` discriminator. See the TS file for the traffic
// classes (handshake / ephemeral / reliable / state) and the resumability rules.

import Foundation

public let protocolVersion = 1
public let bonjourServiceType = "_relay._tcp"
public let wsPath = "/relay"

// MARK: - Shared value types

public enum AgentStatus: String, Codable, Sendable, Equatable {
    case working, waiting, idle, ended
    case needsPermission = "needs_permission"
}

public struct AgentSession: Codable, Sendable, Equatable {
    public var id: String
    public var provider: String
    public var title: String
    public var projectPath: String
    public var status: AgentStatus
    public var statusDetail: String?
    public var lastActivity: String
    public var lastActivityAt: Double
    public var canRespond: Bool

    public init(id: String, provider: String, title: String, projectPath: String, status: AgentStatus,
                statusDetail: String? = nil, lastActivity: String, lastActivityAt: Double, canRespond: Bool) {
        self.id = id; self.provider = provider; self.title = title; self.projectPath = projectPath
        self.status = status; self.statusDetail = statusDetail; self.lastActivity = lastActivity
        self.lastActivityAt = lastActivityAt; self.canRespond = canRespond
    }
}

public enum AgentMessageRole: String, Codable, Sendable, Equatable {
    case user, assistant, tool, system
}

public struct AgentMessage: Codable, Sendable, Equatable {
    public struct Tool: Codable, Sendable, Equatable {
        public var name: String
        public var summary: String
        public init(name: String, summary: String) { self.name = name; self.summary = summary }
    }
    public var id: String
    public var role: AgentMessageRole
    public var text: String
    public var at: Double
    public var tool: Tool?

    public init(id: String, role: AgentMessageRole, text: String, at: Double, tool: Tool? = nil) {
        self.id = id; self.role = role; self.text = text; self.at = at; self.tool = tool
    }
}

public struct MacState: Codable, Sendable, Equatable {
    public var name: String
    public var version: String
    public var accessibilityGranted: Bool
    public var agentsAvailable: Bool
    public init(name: String, version: String, accessibilityGranted: Bool, agentsAvailable: Bool) {
        self.name = name; self.version = version
        self.accessibilityGranted = accessibilityGranted; self.agentsAvailable = agentsAvailable
    }
}

public struct AgentsSnapshot: Codable, Sendable, Equatable {
    public var rev: Int
    public var sessions: [AgentSession]
    public init(rev: Int, sessions: [AgentSession]) { self.rev = rev; self.sessions = sessions }
}

public struct Snapshot: Codable, Sendable, Equatable {
    public var mac: MacState
    public var agents: AgentsSnapshot
    public init(mac: MacState, agents: AgentsSnapshot) { self.mac = mac; self.agents = agents }
}

// MARK: - Ephemeral input (phone -> Mac). Units: phone points. t: phone monotonic ms.

public enum MouseButton: String, Codable, Sendable, Equatable { case left, right }
public enum DragPhase: String, Codable, Sendable, Equatable { case start, end }
public enum ScrollPhase: String, Codable, Sendable, Equatable {
    case began, changed, ended, momentum, momentumEnded
}

public enum InputEvent: Codable, Sendable, Equatable {
    case move(dx: Double, dy: Double, t: Double)
    case click(button: MouseButton, t: Double)
    case drag(phase: DragPhase, t: Double)
    case scroll(dx: Double, dy: Double, phase: ScrollPhase, t: Double)

    private enum CodingKeys: String, CodingKey { case k, dx, dy, t, button, phase }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let t = try c.decode(Double.self, forKey: .t)
        switch try c.decode(String.self, forKey: .k) {
        case "move":
            self = .move(dx: try c.decode(Double.self, forKey: .dx), dy: try c.decode(Double.self, forKey: .dy), t: t)
        case "click":
            self = .click(button: try c.decode(MouseButton.self, forKey: .button), t: t)
        case "drag":
            self = .drag(phase: try c.decode(DragPhase.self, forKey: .phase), t: t)
        case "scroll":
            self = .scroll(dx: try c.decode(Double.self, forKey: .dx), dy: try c.decode(Double.self, forKey: .dy),
                           phase: try c.decode(ScrollPhase.self, forKey: .phase), t: t)
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .k, in: c, debugDescription: "unknown input kind \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .move(dx, dy, t):
            try c.encode("move", forKey: .k); try c.encode(dx, forKey: .dx); try c.encode(dy, forKey: .dy); try c.encode(t, forKey: .t)
        case let .click(button, t):
            try c.encode("click", forKey: .k); try c.encode(button, forKey: .button); try c.encode(t, forKey: .t)
        case let .drag(phase, t):
            try c.encode("drag", forKey: .k); try c.encode(phase, forKey: .phase); try c.encode(t, forKey: .t)
        case let .scroll(dx, dy, phase, t):
            try c.encode("scroll", forKey: .k); try c.encode(dx, forKey: .dx); try c.encode(dy, forKey: .dy)
            try c.encode(phase, forKey: .phase); try c.encode(t, forKey: .t)
        }
    }
}

// MARK: - Reliable commands (phone -> Mac)

public enum KeyName: String, Codable, Sendable, Equatable { case `return`, escape, backspace, tab }

public enum Command: Codable, Sendable, Equatable {
    case textInsert(text: String)
    case keyPress(key: KeyName)
    case agentReply(sessionId: String, text: String)

    private enum CodingKeys: String, CodingKey { case kind, text, key, sessionId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "text.insert": self = .textInsert(text: try c.decode(String.self, forKey: .text))
        case "key.press": self = .keyPress(key: try c.decode(KeyName.self, forKey: .key))
        case "agent.reply":
            self = .agentReply(sessionId: try c.decode(String.self, forKey: .sessionId), text: try c.decode(String.self, forKey: .text))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown command \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .textInsert(text): try c.encode("text.insert", forKey: .kind); try c.encode(text, forKey: .text)
        case let .keyPress(key): try c.encode("key.press", forKey: .kind); try c.encode(key, forKey: .key)
        case let .agentReply(sessionId, text):
            try c.encode("agent.reply", forKey: .kind); try c.encode(sessionId, forKey: .sessionId); try c.encode(text, forKey: .text)
        }
    }
}

public struct AckError: Codable, Sendable, Equatable, Error {
    public enum Code: String, Codable, Sendable, Equatable {
        case accessibilityDenied = "accessibility_denied"
        case agentNotFound = "agent_not_found"
        case agentCannotRespond = "agent_cannot_respond"
        case invalidCommand = "invalid_command"
        case internalError = "internal"
    }
    public var code: Code
    public var message: String
    public init(code: Code, message: String) { self.code = code; self.message = message }
}

// MARK: - Phone -> Mac frames

public enum ClientMessage: Codable, Sendable, Equatable {
    case hello(v: Int, deviceId: String, deviceName: String, platform: String)
    case auth(proof: String)
    case pairRequest
    case pairConfirm(pin: String)
    case input(events: [InputEvent])
    case cmd(id: String, cmd: Command)
    case ping(ts: Double)
    case agentsGet
    case agentSubscribe(sessionId: String)
    case agentUnsubscribe(sessionId: String)

    private enum CodingKeys: String, CodingKey {
        case t, v, deviceId, deviceName, platform, proof, pin, events, id, cmd, ts, sessionId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .t) {
        case "hello":
            self = .hello(v: try c.decode(Int.self, forKey: .v), deviceId: try c.decode(String.self, forKey: .deviceId),
                          deviceName: try c.decode(String.self, forKey: .deviceName), platform: try c.decode(String.self, forKey: .platform))
        case "auth": self = .auth(proof: try c.decode(String.self, forKey: .proof))
        case "pair.request": self = .pairRequest
        case "pair.confirm": self = .pairConfirm(pin: try c.decode(String.self, forKey: .pin))
        case "input": self = .input(events: try c.decode([InputEvent].self, forKey: .events))
        case "cmd": self = .cmd(id: try c.decode(String.self, forKey: .id), cmd: try c.decode(Command.self, forKey: .cmd))
        case "ping": self = .ping(ts: try c.decode(Double.self, forKey: .ts))
        case "agents.get": self = .agentsGet
        case "agent.subscribe": self = .agentSubscribe(sessionId: try c.decode(String.self, forKey: .sessionId))
        case "agent.unsubscribe": self = .agentUnsubscribe(sessionId: try c.decode(String.self, forKey: .sessionId))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .t, in: c, debugDescription: "unknown client message \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .hello(v, deviceId, deviceName, platform):
            try c.encode("hello", forKey: .t); try c.encode(v, forKey: .v); try c.encode(deviceId, forKey: .deviceId)
            try c.encode(deviceName, forKey: .deviceName); try c.encode(platform, forKey: .platform)
        case let .auth(proof): try c.encode("auth", forKey: .t); try c.encode(proof, forKey: .proof)
        case .pairRequest: try c.encode("pair.request", forKey: .t)
        case let .pairConfirm(pin): try c.encode("pair.confirm", forKey: .t); try c.encode(pin, forKey: .pin)
        case let .input(events): try c.encode("input", forKey: .t); try c.encode(events, forKey: .events)
        case let .cmd(id, cmd): try c.encode("cmd", forKey: .t); try c.encode(id, forKey: .id); try c.encode(cmd, forKey: .cmd)
        case let .ping(ts): try c.encode("ping", forKey: .t); try c.encode(ts, forKey: .ts)
        case .agentsGet: try c.encode("agents.get", forKey: .t)
        case let .agentSubscribe(sessionId): try c.encode("agent.subscribe", forKey: .t); try c.encode(sessionId, forKey: .sessionId)
        case let .agentUnsubscribe(sessionId): try c.encode("agent.unsubscribe", forKey: .t); try c.encode(sessionId, forKey: .sessionId)
        }
    }
}

// MARK: - Mac -> phone frames

public enum ErrorCode: String, Codable, Sendable, Equatable {
    case versionMismatch = "version_mismatch"
    case unknownDevice = "unknown_device"
    case authFailed = "auth_failed"
    case protocolError = "protocol"
    case busy
}

public enum PairFailure: String, Codable, Sendable, Equatable {
    case wrongPin = "wrong_pin"
    case rejected, timeout
    case tooManyAttempts = "too_many_attempts"
}

public enum ServerMessage: Codable, Sendable, Equatable {
    case challenge(nonce: String)
    case unpaired
    case pairPending
    case pairOk(secret: String)
    case pairFailed(reason: PairFailure)
    case welcome(state: Snapshot)
    case error(code: ErrorCode, message: String)
    case macState(mac: MacState)
    case agentsSnapshot(rev: Int, sessions: [AgentSession])
    case agentsDelta(rev: Int, upsert: [AgentSession]?, remove: [String]?)
    case agentConversation(sessionId: String, rev: Int, messages: [AgentMessage])
    case agentMessages(sessionId: String, rev: Int, append: [AgentMessage])
    case ack(id: String)
    case nack(id: String, error: AckError)
    case pong(ts: Double, serverTs: Double)

    private enum CodingKeys: String, CodingKey {
        case t, nonce, secret, reason, state, code, message, mac, rev, sessions, upsert, remove
        case sessionId, messages, append, id, error, ts, serverTs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .t) {
        case "challenge": self = .challenge(nonce: try c.decode(String.self, forKey: .nonce))
        case "unpaired": self = .unpaired
        case "pair.pending": self = .pairPending
        case "pair.ok": self = .pairOk(secret: try c.decode(String.self, forKey: .secret))
        case "pair.failed": self = .pairFailed(reason: try c.decode(PairFailure.self, forKey: .reason))
        case "welcome": self = .welcome(state: try c.decode(Snapshot.self, forKey: .state))
        case "error": self = .error(code: try c.decode(ErrorCode.self, forKey: .code), message: try c.decode(String.self, forKey: .message))
        case "mac.state": self = .macState(mac: try c.decode(MacState.self, forKey: .mac))
        case "agents.snapshot":
            self = .agentsSnapshot(rev: try c.decode(Int.self, forKey: .rev), sessions: try c.decode([AgentSession].self, forKey: .sessions))
        case "agents.delta":
            self = .agentsDelta(rev: try c.decode(Int.self, forKey: .rev),
                                upsert: try c.decodeIfPresent([AgentSession].self, forKey: .upsert),
                                remove: try c.decodeIfPresent([String].self, forKey: .remove))
        case "agent.conversation":
            self = .agentConversation(sessionId: try c.decode(String.self, forKey: .sessionId), rev: try c.decode(Int.self, forKey: .rev),
                                      messages: try c.decode([AgentMessage].self, forKey: .messages))
        case "agent.messages":
            self = .agentMessages(sessionId: try c.decode(String.self, forKey: .sessionId), rev: try c.decode(Int.self, forKey: .rev),
                                  append: try c.decode([AgentMessage].self, forKey: .append))
        case "ack": self = .ack(id: try c.decode(String.self, forKey: .id))
        case "nack": self = .nack(id: try c.decode(String.self, forKey: .id), error: try c.decode(AckError.self, forKey: .error))
        case "pong": self = .pong(ts: try c.decode(Double.self, forKey: .ts), serverTs: try c.decode(Double.self, forKey: .serverTs))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .t, in: c, debugDescription: "unknown server message \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .challenge(nonce): try c.encode("challenge", forKey: .t); try c.encode(nonce, forKey: .nonce)
        case .unpaired: try c.encode("unpaired", forKey: .t)
        case .pairPending: try c.encode("pair.pending", forKey: .t)
        case let .pairOk(secret): try c.encode("pair.ok", forKey: .t); try c.encode(secret, forKey: .secret)
        case let .pairFailed(reason): try c.encode("pair.failed", forKey: .t); try c.encode(reason, forKey: .reason)
        case let .welcome(state): try c.encode("welcome", forKey: .t); try c.encode(state, forKey: .state)
        case let .error(code, message):
            try c.encode("error", forKey: .t); try c.encode(code, forKey: .code); try c.encode(message, forKey: .message)
        case let .macState(mac): try c.encode("mac.state", forKey: .t); try c.encode(mac, forKey: .mac)
        case let .agentsSnapshot(rev, sessions):
            try c.encode("agents.snapshot", forKey: .t); try c.encode(rev, forKey: .rev); try c.encode(sessions, forKey: .sessions)
        case let .agentsDelta(rev, upsert, remove):
            try c.encode("agents.delta", forKey: .t); try c.encode(rev, forKey: .rev)
            try c.encodeIfPresent(upsert, forKey: .upsert); try c.encodeIfPresent(remove, forKey: .remove)
        case let .agentConversation(sessionId, rev, messages):
            try c.encode("agent.conversation", forKey: .t); try c.encode(sessionId, forKey: .sessionId)
            try c.encode(rev, forKey: .rev); try c.encode(messages, forKey: .messages)
        case let .agentMessages(sessionId, rev, append):
            try c.encode("agent.messages", forKey: .t); try c.encode(sessionId, forKey: .sessionId)
            try c.encode(rev, forKey: .rev); try c.encode(append, forKey: .append)
        case let .ack(id): try c.encode("ack", forKey: .t); try c.encode(id, forKey: .id)
        case let .nack(id, error): try c.encode("nack", forKey: .t); try c.encode(id, forKey: .id); try c.encode(error, forKey: .error)
        case let .pong(ts, serverTs):
            try c.encode("pong", forKey: .t); try c.encode(ts, forKey: .ts); try c.encode(serverTs, forKey: .serverTs)
        }
    }
}

// MARK: - Codec

public enum Wire {
    public static let decoder = JSONDecoder()
    public static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    public static func decodeClient(_ data: Data) throws -> ClientMessage { try decoder.decode(ClientMessage.self, from: data) }
    public static func decodeServer(_ data: Data) throws -> ServerMessage { try decoder.decode(ServerMessage.self, from: data) }
    public static func encode(_ m: ServerMessage) throws -> Data { try encoder.encode(m) }
    public static func encode(_ m: ClientMessage) throws -> Data { try encoder.encode(m) }
}
