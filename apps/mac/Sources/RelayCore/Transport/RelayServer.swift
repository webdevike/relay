import CryptoKit
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
    public private(set) var port: UInt16?

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
                        self.port = p
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
            for entry in sessions.values {
                entry.connection.cancel()
            }
            sessions.removeAll()
            port = nil
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
        let frameSink = NWConnectionFrameSink(connection: connection)
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
            if error != nil {
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

    init(connection: NWConnection) {
        self.connection = connection
    }

    func send(_ message: ServerMessage) {
        guard let data = try? Wire.encode(message) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "relay", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }
}
