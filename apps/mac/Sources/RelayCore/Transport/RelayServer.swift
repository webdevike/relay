import Foundation
import Network
import RelayProtocol

/// Bonjour-advertised WebSocket server (`_relay._tcp`, path `/relay`). One `ClientSession` per
/// accepted connection; every session mutation, every `NWListener`/`NWConnection` handler, and
/// every `AgentProvider.onChange` callback is funneled onto `queue`. See `Transport/README.md`.
public final class RelayServer {
    public struct Config {
        public var port: UInt16?
        public var macName: String
        public var version: String

        public init(port: UInt16? = nil, macName: String, version: String) {
            self.port = port
            self.macName = macName
            self.version = version
        }
    }

    public struct Dependencies {
        public var input: InputSink
        public var text: TextInjecting
        public var accessibility: AccessibilityChecking
        public var agents: AgentProvider?
        public var devices: DeviceStore
        public var pairing: PairingUI

        public init(
            input: InputSink,
            text: TextInjecting,
            accessibility: AccessibilityChecking,
            agents: AgentProvider?,
            devices: DeviceStore,
            pairing: PairingUI
        ) {
            self.input = input
            self.text = text
            self.accessibility = accessibility
            self.agents = agents
            self.devices = devices
            self.pairing = pairing
        }
    }

    public enum ServerState: Equatable {
        case stopped
        case starting
        case listening(port: UInt16)
        case failed(String)
    }

    public struct ConnectedDevice: Equatable {
        public let deviceId: String
        public let deviceName: String
        public let connectedAt: Date
    }

    private struct SessionEntry {
        let session: ClientSession
        let connection: NWConnection
        let connectedAt: Date
    }

    public var onStateChange: ((ServerState) -> Void)?
    public var port: UInt16? { queue.sync { _port } }

    public var connectedDevices: [ConnectedDevice] {
        queue.sync {
            sessions.values.compactMap { entry in
                guard entry.session.isAuthenticated, let deviceId = entry.session.deviceId else { return nil }
                return ConnectedDevice(deviceId: deviceId, deviceName: entry.session.deviceName ?? "", connectedAt: entry.connectedAt)
            }
        }
    }

    private let config: Config
    private let deps: Dependencies
    private let queue = DispatchQueue(label: "com.ike.relay.server")
    private let dedup = CommandDedupStore()
    private let agentsTracker = AgentsDeltaTracker()
    private let pairingCoordinator: PairingCoordinator
    private var listener: NWListener?
    private var sessions: [ObjectIdentifier: SessionEntry] = [:]
    private var state: ServerState = .stopped
    private var _port: UInt16?

    public init(config: Config, deps: Dependencies) {
        self.config = config
        self.deps = deps
        pairingCoordinator = PairingCoordinator(pairingUI: deps.pairing)
    }

    public func start() throws {
        try queue.sync {
            guard listener == nil else { return }
            setState(.starting)

            if let agents = deps.agents {
                agents.start()
                agentsTracker.seed(agents.sessions)
                agents.onChange = { [weak self] change in
                    guard let self else { return }
                    self.queue.async { self.handleProviderChange(change) }
                }
            }

            let parameters = Self.makeParameters()
            let nwPort = config.port.flatMap { NWEndpoint.Port(rawValue: $0) } ?? .any
            let newListener: NWListener
            do {
                newListener = try NWListener(using: parameters, on: nwPort)
            } catch {
                setState(.failed(String(describing: error)))
                throw error
            }

            var txt = NWTXTRecord()
            txt["v"] = "1"
            txt["name"] = config.macName
            newListener.service = NWListener.Service(name: config.macName, type: bonjourServiceType, txtRecord: txt.data)

            newListener.stateUpdateHandler = { [weak self] nwState in
                guard let self else { return }
                switch nwState {
                case .ready:
                    if let p = newListener.port?.rawValue {
                        self._port = p
                        self.setState(.listening(port: p))
                    }
                case let .failed(error):
                    self.setState(.failed(String(describing: error)))
                case .cancelled:
                    self.setState(.stopped)
                default:
                    break
                }
            }
            newListener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            newListener.start(queue: queue)
            listener = newListener
        }
    }

    public func stop() {
        queue.sync {
            listener?.stateUpdateHandler = nil
            listener?.newConnectionHandler = nil
            listener?.cancel()
            listener = nil
            let entries = Array(sessions.values)
            for entry in entries {
                entry.session.handleDisconnect()
                entry.connection.cancel()
            }
            sessions.removeAll()
            _port = nil
            deps.agents?.onChange = nil
            setState(.stopped)
        }
    }

    /// Call when `AccessibilityChecking.isTrusted` changes; pushes `mac.state` to every
    /// authenticated session.
    public func broadcastMacState() {
        queue.async {
            let mac = MacState(
                name: self.config.macName, version: self.config.version,
                accessibilityGranted: self.deps.accessibility.isTrusted,
                agentsAvailable: self.deps.agents?.isAvailable ?? false
            )
            let message = ServerMessage.macState(mac: mac)
            for entry in self.sessions.values {
                entry.session.broadcast(message)
            }
        }
    }

    private func setState(_ newState: ServerState) {
        state = newState
        onStateChange?(newState)
    }

    private func handleProviderChange(_ change: AgentProviderChange) {
        switch change {
        case .sessions:
            guard let agents = deps.agents else { return }
            let message = agentsTracker.apply(agents.sessions)
            for entry in sessions.values {
                entry.session.broadcast(message)
            }
        case let .conversation(sessionId, appended):
            for entry in sessions.values {
                entry.session.agentConversationAppended(sessionId: sessionId, messages: appended)
            }
        }
    }

    private func accept(_ connection: NWConnection) {
        let frameSink = NWConnectionFrameSink(connection: connection, queue: queue)
        let sessionDeps = ClientSession.Dependencies(
            macName: config.macName, version: config.version,
            input: deps.input, text: deps.text, accessibility: deps.accessibility,
            agents: deps.agents, devices: deps.devices, pairing: pairingCoordinator,
            dedup: dedup, agentsTracker: agentsTracker
        )
        let session = ClientSession(sink: frameSink, deps: sessionDeps, queue: queue, onClose: { [weak self] closed in
            self?.remove(closed)
        })
        sessions[ObjectIdentifier(session)] = SessionEntry(session: session, connection: connection, connectedAt: Date())

        connection.stateUpdateHandler = { [weak self, weak session] nwState in
            guard let self, let session else { return }
            switch nwState {
            case .failed, .cancelled:
                session.handleDisconnect()
                self.remove(session)
            default:
                break
            }
        }
        connection.start(queue: queue)
        receiveLoop(connection: connection, session: session)
    }

    private func remove(_ session: ClientSession) {
        sessions.removeValue(forKey: ObjectIdentifier(session))
    }

    private func receiveLoop(connection: NWConnection, session: ClientSession) {
        connection.receiveMessage { [weak self, weak session] data, _, _, error in
            guard let self, let session else { return }
            if let data, !data.isEmpty {
                session.receive(data)
            }
            if error != nil || session.isClosed {
                session.handleDisconnect()
                self.remove(session)
                return
            }
            guard connection.state != .cancelled else { return }
            self.receiveLoop(connection: connection, session: session)
        }
    }

    private static func makeParameters() -> NWParameters {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.includePeerToPeer = true
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
        return parameters
    }
}

private final class NWConnectionFrameSink: FrameSink {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private var pendingSends = 0
    private var closeRequested = false
    private var didCancel = false

    init(connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
    }

    func send(_ message: ServerMessage) {
        guard let data = try? Wire.encode(message) else { return }
        pendingSends += 1
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "relay", metadata: [metadata])
        // Strong `self`, deliberately: once `RelayServer.remove()` drops the owning `ClientSession`,
        // this sink may be the last thing keeping the in-flight send's bookkeeping alive. The chain
        // is short-lived and self-terminating (ends at `cancelNow`), so this is not a retain cycle.
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { [self] _ in
            self.queue.async { self.sendCompleted() }
        })
    }

    /// Cancels once any already-queued `send`'s completion fires, so the final frame is not
    /// dropped by an immediate cancel. Some environments never invoke that completion for a
    /// connection about to close, so this also arms a short best-effort grace-period backstop.
    /// All mutation happens on `queue` (the server's serial queue) to stay race-free between the
    /// completion callback and the backstop timer.
    func close() {
        queue.async { [self] in
            self.closeRequested = true
            self.cancelIfIdle()
        }
        queue.asyncAfter(deadline: .now() + 0.2) { [self] in
            self.cancelNow()
        }
    }

    private func sendCompleted() {
        pendingSends -= 1
        cancelIfIdle()
    }

    private func cancelIfIdle() {
        guard closeRequested, pendingSends <= 0 else { return }
        cancelNow()
    }

    /// Plain `cancel()`: a standalone repro confirmed the peer's `receive` completion reliably
    /// observes this as a failure even without an explicit WebSocket close frame first, and that
    /// an explicit close-opcode send before cancelling made the teardown hang in this sandbox.
    private func cancelNow() {
        guard !didCancel else { return }
        didCancel = true
        connection.cancel()
    }
}
