import CryptoKit
import Foundation
import RelayProtocol

/// One phone<->Mac connection. All mutation happens on the `queue` handed in by the server; the
/// session is otherwise a pure state machine plus seam calls and outbound frames via `FrameSink`.
/// State machine: `awaitingHello -> (challenged | unpairedWaiting | pairingPending) ->
/// authenticated -> closed`.
final class ClientSession: @unchecked Sendable {
    struct Dependencies {
        let macName: String
        let version: String
        let input: InputSink
        let text: TextInjecting
        let accessibility: AccessibilityChecking
        let agents: AgentProvider?
        let devices: DeviceStore
        let pairing: PairingCoordinator
        let dedup: CommandDedupStore
        let agentsTracker: AgentsDeltaTracker
    }

    private enum Phase {
        case awaitingHello
        case challenged(deviceId: String, nonce: String, secret: Data)
        case unpairedWaiting(deviceId: String, deviceName: String)
        case pairingPending(deviceId: String, deviceName: String, pin: String, attempts: Int)
        case authenticated(deviceId: String)
    }

    private let sink: FrameSink
    private let deps: Dependencies
    private let queue: DispatchQueue
    private let now: () -> Date
    private let onClose: (ClientSession) -> Void

    private var phase: Phase = .awaitingHello
    private var subscriptions: [String: Int] = [:]
    private var pairingTimeout: DispatchWorkItem?
    private(set) var isClosed = false
    private(set) var deviceName: String?

    init(
        sink: FrameSink,
        deps: Dependencies,
        queue: DispatchQueue,
        now: @escaping () -> Date = Date.init,
        onClose: @escaping (ClientSession) -> Void = { _ in }
    ) {
        self.sink = sink
        self.deps = deps
        self.queue = queue
        self.now = now
        self.onClose = onClose
    }

    deinit {
        pairingTimeout?.cancel()
    }

    var deviceId: String? {
        switch phase {
        case .awaitingHello: return nil
        case let .challenged(deviceId, _, _): return deviceId
        case let .unpairedWaiting(deviceId, _): return deviceId
        case let .pairingPending(deviceId, _, _, _): return deviceId
        case let .authenticated(deviceId): return deviceId
        }
    }

    var isAuthenticated: Bool {
        if case .authenticated = phase { return true }
        return false
    }

    /// Sends `message` only once authenticated; used by the server to broadcast state topics
    /// (`mac.state`, `agents.delta`).
    func broadcast(_ message: ServerMessage) {
        guard isAuthenticated else { return }
        sink.send(message)
    }

    /// Forwards newly appended agent messages if (and only if) this session is subscribed to
    /// `sessionId`; bumps this session's own per-subscription rev.
    func agentConversationAppended(sessionId: String, messages: [AgentMessage]) {
        guard isAuthenticated, let currentRev = subscriptions[sessionId], !messages.isEmpty else { return }
        let newRev = currentRev + 1
        subscriptions[sessionId] = newRev
        sink.send(.agentMessages(sessionId: sessionId, rev: newRev, append: messages))
    }

    func receive(_ data: Data) {
        guard !isClosed else { return }
        guard let message = try? Wire.decodeClient(data) else {
            failProtocol("malformed json")
            return
        }
        receive(message)
    }

    func receive(_ message: ClientMessage) {
        guard !isClosed else { return }
        switch phase {
        case .awaitingHello: handleAwaitingHello(message)
        case .challenged: handleChallenged(message)
        case .unpairedWaiting: handleUnpairedWaiting(message)
        case .pairingPending: handlePairingPending(message)
        case .authenticated: handleAuthenticated(message)
        }
    }

    /// The connection dropped. Normal: no logging above debug, no retry, session freed by the
    /// server after this returns.
    func handleDisconnect() {
        guard !isClosed else { return }
        endPairingIfPending()
        cancelPairingTimeout()
        isClosed = true
        onClose(self)
    }

    // MARK: - Phases

    private func handleAwaitingHello(_ message: ClientMessage) {
        guard case let .hello(v, deviceId, deviceName, _) = message else {
            failProtocol("expected hello")
            return
        }
        guard v == protocolVersion else {
            fail(.versionMismatch, "unsupported protocol version \(v)")
            return
        }
        self.deviceName = deviceName
        if let secret = deps.devices.secret(for: deviceId) {
            let nonce = Data.relayRandomBytes(32).hexString
            phase = .challenged(deviceId: deviceId, nonce: nonce, secret: secret)
            sink.send(.challenge(nonce: nonce))
        } else {
            phase = .unpairedWaiting(deviceId: deviceId, deviceName: deviceName)
            sink.send(.unpaired)
        }
    }

    private func handleChallenged(_ message: ClientMessage) {
        guard case let .challenged(deviceId, nonce, secret) = phase else { return }
        guard case let .auth(proof) = message else {
            failProtocol("expected auth")
            return
        }
        guard let proofData = Data(hexString: proof) else {
            fail(.authFailed, "malformed proof")
            return
        }
        let key = SymmetricKey(data: secret)
        let valid = HMAC<SHA256>.isValidAuthenticationCode(proofData, authenticating: Data(nonce.utf8), using: key)
        guard valid else {
            fail(.authFailed, "invalid proof")
            return
        }
        authenticate(deviceId: deviceId)
    }

    private func handleUnpairedWaiting(_ message: ClientMessage) {
        guard case let .unpairedWaiting(deviceId, deviceName) = phase else { return }
        guard case .pairRequest = message else {
            failProtocol("expected pair.request")
            return
        }
        let pin = Self.generatePin()
        guard deps.pairing.begin(deviceName: deviceName, pin: pin) else {
            fail(.busy, "another pairing is already in progress")
            return
        }
        phase = .pairingPending(deviceId: deviceId, deviceName: deviceName, pin: pin, attempts: 0)
        schedulePairingTimeout()
        sink.send(.pairPending)
    }

    private func handlePairingPending(_ message: ClientMessage) {
        guard case let .pairingPending(deviceId, deviceName, pin, attempts) = phase else { return }
        guard case let .pairConfirm(enteredPin) = message else {
            failProtocol("expected pair.confirm")
            return
        }
        guard enteredPin == pin else {
            let nextAttempts = attempts + 1
            if nextAttempts >= 3 {
                cancelPairingTimeout()
                deps.pairing.end()
                isClosed = true
                sink.send(.pairFailed(reason: .tooManyAttempts))
                sink.close()
                onClose(self)
            } else {
                phase = .pairingPending(deviceId: deviceId, deviceName: deviceName, pin: pin, attempts: nextAttempts)
                sink.send(.pairFailed(reason: .wrongPin))
            }
            return
        }
        cancelPairingTimeout()
        let secret = Data.relayRandomBytes(32)
        deps.devices.save(secret: secret, deviceId: deviceId, deviceName: deviceName)
        deps.pairing.end()
        sink.send(.pairOk(secret: secret.hexString))
        authenticate(deviceId: deviceId)
    }

    private func handleAuthenticated(_ message: ClientMessage) {
        guard case .authenticated = phase, let deviceId else { return }
        switch message {
        case let .input(events):
            guard deps.accessibility.isTrusted else { return }
            deps.input.handle(events)
        case let .cmd(id, cmd):
            handleCmd(id: id, cmd: cmd, deviceId: deviceId)
        case let .ping(ts):
            sink.send(.pong(ts: ts, serverTs: now().timeIntervalSince1970 * 1000))
        case .agentsGet:
            sink.send(.agentsSnapshot(rev: deps.agentsTracker.rev, sessions: deps.agentsTracker.sessions))
        case let .agentSubscribe(sessionId):
            subscriptions[sessionId] = 0
            let messages = deps.agents?.conversation(for: sessionId) ?? []
            sink.send(.agentConversation(sessionId: sessionId, rev: 0, messages: messages))
        case let .agentUnsubscribe(sessionId):
            subscriptions.removeValue(forKey: sessionId)
        case .hello, .auth, .pairRequest, .pairConfirm:
            failProtocol("unexpected handshake message while authenticated")
        }
    }

    private func handleCmd(id: String, cmd: Command, deviceId: String) {
        switch deps.dedup.begin(deviceId: deviceId, id: id, waiter: sink) {
        case let .completed(response):
            sink.send(response)
            return
        case .inFlight:
            // The original call for this id hasn't finished; `complete` will notify our `sink`
            // (registered above as a waiter) once it does. Do not re-execute.
            return
        case .fresh:
            break
        }
        switch cmd {
        case let .textInsert(text):
            respond(id: id, deviceId: deviceId) { try self.deps.text.insert(text) }
        case let .keyPress(key):
            respond(id: id, deviceId: deviceId) { try self.deps.text.press(key) }
        case let .agentReply(sessionId, text):
            guard let agents = deps.agents else {
                complete(
                    id: id, deviceId: deviceId,
                    response: .nack(id: id, error: AckError(code: .agentCannotRespond, message: "no agent provider available"))
                )
                return
            }
            Task { [weak self] in
                guard let self else { return }
                do {
                    try await agents.reply(sessionId: sessionId, text: text)
                    self.queue.async { self.complete(id: id, deviceId: deviceId, response: .ack(id: id)) }
                } catch let error as AckError {
                    self.queue.async { self.complete(id: id, deviceId: deviceId, response: .nack(id: id, error: error)) }
                } catch {
                    self.queue.async {
                        self.complete(
                            id: id, deviceId: deviceId,
                            response: .nack(id: id, error: AckError(code: .internalError, message: String(describing: error)))
                        )
                    }
                }
            }
        }
    }

    private func respond(id: String, deviceId: String, action: () throws -> Void) {
        guard deps.accessibility.isTrusted else {
            complete(
                id: id, deviceId: deviceId,
                response: .nack(id: id, error: AckError(code: .accessibilityDenied, message: "accessibility not trusted"))
            )
            return
        }
        do {
            try action()
            complete(id: id, deviceId: deviceId, response: .ack(id: id))
        } catch let error as AckError {
            complete(id: id, deviceId: deviceId, response: .nack(id: id, error: error))
        } catch {
            complete(
                id: id, deviceId: deviceId,
                response: .nack(id: id, error: AckError(code: .internalError, message: String(describing: error)))
            )
        }
    }

    private func complete(id: String, deviceId: String, response: ServerMessage) {
        deps.dedup.complete(deviceId: deviceId, id: id, response: response)
        sink.send(response)
    }

    private func authenticate(deviceId: String) {
        phase = .authenticated(deviceId: deviceId)
        let snapshot = SnapshotBuilder.build(
            macName: deps.macName, version: deps.version, accessibility: deps.accessibility,
            agents: deps.agents, agentsTracker: deps.agentsTracker
        )
        sink.send(.welcome(state: snapshot))
    }

    // MARK: - Pairing timeout

    private func schedulePairingTimeout() {
        let item = DispatchWorkItem { [weak self] in self?.pairingTimedOut() }
        pairingTimeout = item
        queue.asyncAfter(deadline: .now() + 120, execute: item)
    }

    private func cancelPairingTimeout() {
        pairingTimeout?.cancel()
        pairingTimeout = nil
    }

    private func pairingTimedOut() {
        guard case .pairingPending = phase, !isClosed else { return }
        deps.pairing.end()
        isClosed = true
        sink.send(.pairFailed(reason: .timeout))
        sink.close()
        onClose(self)
    }

    private func endPairingIfPending() {
        if case .pairingPending = phase {
            deps.pairing.end()
        }
    }

    // MARK: - Errors

    private func fail(_ code: ErrorCode, _ message: String) {
        endPairingIfPending()
        cancelPairingTimeout()
        isClosed = true
        sink.send(.error(code: code, message: message))
        sink.close()
        onClose(self)
    }

    private func failProtocol(_ message: String) {
        fail(.protocolError, message)
    }

    private static func generatePin() -> String {
        var generator = SystemRandomNumberGenerator()
        let value = Int.random(in: 0...999_999, using: &generator)
        return String(format: "%06d", value)
    }
}
