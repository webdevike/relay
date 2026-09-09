import Foundation
import RelayProtocol
@testable import RelayCore

final class FakeFrameSink: FrameSink {
    private(set) var sent: [ServerMessage] = []

    func send(_ message: ServerMessage) {
        sent.append(message)
    }
}

final class FakeInputSink: InputSink {
    private(set) var received: [[InputEvent]] = []

    func handle(_ events: [InputEvent]) {
        received.append(events)
    }
}

final class FakeTextInjecting: TextInjecting {
    private(set) var insertedText: [String] = []
    private(set) var pressedKeys: [KeyName] = []
    var insertError: AckError?
    var pressError: AckError?

    func insert(_ text: String) throws {
        if let insertError { throw insertError }
        insertedText.append(text)
    }

    func press(_ key: KeyName) throws {
        if let pressError { throw pressError }
        pressedKeys.append(key)
    }
}

final class FakeAccessibilityChecking: AccessibilityChecking {
    var isTrusted: Bool = true
    private(set) var requestAccessCalled = false

    func requestAccess() {
        requestAccessCalled = true
    }
}

final class FakeAgentProvider: AgentProvider {
    var id: String = "fake"
    var isAvailable: Bool = true
    private(set) var startCalled = false
    var sessions: [AgentSession] = []
    var conversations: [String: [AgentMessage]] = [:]
    var replyError: AckError?
    private(set) var replies: [(sessionId: String, text: String)] = []
    var onChange: ((AgentProviderChange) -> Void)?

    func start() {
        startCalled = true
    }

    func conversation(for sessionId: String) -> [AgentMessage]? {
        conversations[sessionId]
    }

    func reply(sessionId: String, text: String) async throws {
        if let replyError { throw replyError }
        replies.append((sessionId, text))
    }
}

final class FakeDeviceStore: DeviceStore {
    private var secrets: [String: Data] = [:]
    private var names: [String: String] = [:]
    private var pairedAtByDevice: [String: Date] = [:]

    func secret(for deviceId: String) -> Data? {
        secrets[deviceId]
    }

    func save(secret: Data, deviceId: String, deviceName: String) {
        secrets[deviceId] = secret
        names[deviceId] = deviceName
        pairedAtByDevice[deviceId] = Date()
    }

    func forget(deviceId: String) {
        secrets.removeValue(forKey: deviceId)
        names.removeValue(forKey: deviceId)
        pairedAtByDevice.removeValue(forKey: deviceId)
    }

    func pairedDevices() -> [PairedDevice] {
        secrets.keys.map { PairedDevice(id: $0, name: names[$0] ?? "", pairedAt: pairedAtByDevice[$0] ?? Date()) }
    }
}

final class FakePairingUI: PairingUI {
    private(set) var beganWith: (deviceName: String, pin: String)?
    private(set) var endCallCount = 0

    func beginPairing(deviceName: String, pin: String) {
        beganWith = (deviceName, pin)
    }

    func endPairing() {
        endCallCount += 1
    }
}
