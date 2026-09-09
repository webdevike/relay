// QA attack suite for MacTransport, beyond the IC's 8 named ClientSessionTests cases: double
// handshake frames, out-of-phase auth/pairing frames, malformed pins, pairing-coordinator release
// races, dedup boundaries (per-device isolation, 256-entry eviction), the 256-event input cap,
// agent.reply failure paths, malformed/binary frames, and a real-socket stop()/restart() cycle.
// See the QA report for two confirmed gaps that are deliberately NOT defended here because they
// fail against the current implementation: (1) `pair.confirm` with a non-6-digit pin is not
// rejected at decode (RelayProtocol's ClientMessage mirror has no regex, unlike the TS zod
// schema), so a malformed pin is treated as an ordinary wrong-pin attempt instead of a protocol
// error; (2) a session-initiated close (protocol/version/busy/auth/too-many-attempts) never calls
// NWConnection.cancel(), so "+ close" only marks the ClientSession closed -- the underlying socket
// is left open until the client, or the network, tears it down.
import CryptoKit
import Foundation
import RelayProtocol
import XCTest
@testable import RelayCore

final class TransportQATests: XCTestCase {
    // MARK: - Fixture (duplicated from ClientSessionTests, which is file-private there)

    private struct Fixture {
        let session: ClientSession
        let sink: FakeFrameSink
        let devices: FakeDeviceStore
        let pairingUI: FakePairingUI
        let accessibility: FakeAccessibilityChecking
        let text: FakeTextInjecting
        let input: FakeInputSink
        let agentsTracker: AgentsDeltaTracker
        let dedup: CommandDedupStore
    }

    private func makeFixture(
        devices: FakeDeviceStore = FakeDeviceStore(),
        pairingUI: FakePairingUI = FakePairingUI(),
        accessibility: FakeAccessibilityChecking = FakeAccessibilityChecking(),
        text: FakeTextInjecting = FakeTextInjecting(),
        input: FakeInputSink = FakeInputSink(),
        agents: AgentProvider? = FakeAgentProvider(),
        agentsTracker: AgentsDeltaTracker = AgentsDeltaTracker(),
        dedup: CommandDedupStore = CommandDedupStore(),
        pairingCoordinator: PairingCoordinator? = nil
    ) -> Fixture {
        let sink = FakeFrameSink()
        let coordinator = pairingCoordinator ?? PairingCoordinator(pairingUI: pairingUI)
        let deps = ClientSession.Dependencies(
            macName: "Test Mac", version: "1.0",
            input: input, text: text, accessibility: accessibility,
            agents: agents, devices: devices, pairing: coordinator,
            dedup: dedup, agentsTracker: agentsTracker
        )
        let session = ClientSession(sink: sink, deps: deps, queue: DispatchQueue(label: "qa.transport.session"))
        return Fixture(
            session: session, sink: sink, devices: devices, pairingUI: pairingUI,
            accessibility: accessibility, text: text, input: input,
            agentsTracker: agentsTracker, dedup: dedup
        )
    }

    /// Drives hello + challenge/auth to `welcome`, using a real HMAC proof.
    @discardableResult
    private func authenticate(_ fixture: Fixture, deviceId: String, secret: Data, deviceName: String = "iPhone") -> Bool {
        fixture.devices.save(secret: secret, deviceId: deviceId, deviceName: deviceName)
        fixture.session.receive(.hello(v: protocolVersion, deviceId: deviceId, deviceName: deviceName, platform: "ios"))
        guard case let .challenge(nonce) = fixture.sink.sent.last else { return false }
        let key = SymmetricKey(data: secret)
        let mac = HMAC<SHA256>.authenticationCode(for: Data(nonce.utf8), using: key)
        let proof = Data(mac).hexString
        fixture.session.receive(.auth(proof: proof))
        if case .welcome = fixture.sink.sent.last { return true }
        return false
    }

    // MARK: - hello twice

    func testHelloTwiceWhileChallengedFailsProtocolNotCrash() {
        let secret = Data(repeating: 9, count: 32)
        let devices = FakeDeviceStore()
        devices.save(secret: secret, deviceId: "d1", deviceName: "iPhone")
        let fixture = makeFixture(devices: devices)
        fixture.session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone", platform: "ios"))
        guard case .challenge = fixture.sink.sent.last else { return XCTFail("expected challenge") }

        fixture.session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone", platform: "ios"))
        guard case let .error(code, _) = fixture.sink.sent.last else { return XCTFail("expected protocol error") }
        XCTAssertEqual(code, .protocolError)
        XCTAssertTrue(fixture.session.isClosed)
    }

    func testHelloTwiceWhileUnpairedWaitingFailsProtocol() {
        let fixture = makeFixture()
        fixture.session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone", platform: "ios"))
        guard case .unpaired = fixture.sink.sent.last else { return XCTFail("expected unpaired") }

        fixture.session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone", platform: "ios"))
        guard case let .error(code, _) = fixture.sink.sent.last else { return XCTFail("expected protocol error") }
        XCTAssertEqual(code, .protocolError)
        XCTAssertTrue(fixture.session.isClosed)
    }

    // MARK: - auth before challenge

    func testAuthAsFirstFrameFailsProtocolNotVersionMismatch() {
        let fixture = makeFixture()
        fixture.session.receive(.auth(proof: "00"))
        guard case let .error(code, _) = fixture.sink.sent.last else { return XCTFail("expected protocol error") }
        // Not every non-hello first frame is a version problem: only a `hello` with the wrong `v`
        // is `versionMismatch`. Anything else in `awaitingHello` is a generic protocol violation.
        XCTAssertEqual(code, .protocolError)
        XCTAssertTrue(fixture.session.isClosed)
    }

    func testAuthWhileUnpairedWaitingFailsProtocol() {
        let fixture = makeFixture()
        fixture.session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone", platform: "ios"))
        guard case .unpaired = fixture.sink.sent.last else { return XCTFail("expected unpaired") }
        fixture.session.receive(.auth(proof: "00"))
        guard case let .error(code, _) = fixture.sink.sent.last else { return XCTFail("expected protocol error") }
        XCTAssertEqual(code, .protocolError)
        XCTAssertTrue(fixture.session.isClosed)
    }

    // MARK: - pair.confirm before pair.request

    func testPairConfirmBeforePairRequestFailsProtocol() {
        let pairingUI = FakePairingUI()
        let fixture = makeFixture(pairingUI: pairingUI)
        fixture.session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone", platform: "ios"))
        guard case .unpaired = fixture.sink.sent.last else { return XCTFail("expected unpaired") }

        fixture.session.receive(.pairConfirm(pin: "123456"))
        guard case let .error(code, _) = fixture.sink.sent.last else { return XCTFail("expected protocol error") }
        XCTAssertEqual(code, .protocolError)
        XCTAssertTrue(fixture.session.isClosed)
        XCTAssertEqual(pairingUI.endCallCount, 0, "pairing was never begun; endPairing must not fire")
    }

    // MARK: - pair.request from two sessions; first disconnecting frees the coordinator

    func testFirstPairerDisconnectFreesCoordinatorForNextPairer() {
        let pairingUI = FakePairingUI()
        let coordinator = PairingCoordinator(pairingUI: pairingUI)
        let first = makeFixture(pairingUI: pairingUI, pairingCoordinator: coordinator)
        let second = makeFixture(pairingUI: pairingUI, pairingCoordinator: coordinator)
        let third = makeFixture(pairingUI: pairingUI, pairingCoordinator: coordinator)

        first.session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone 1", platform: "ios"))
        first.session.receive(.pairRequest)
        guard case .pairPending = first.sink.sent.last else { return XCTFail("first pairing should start") }

        second.session.receive(.hello(v: protocolVersion, deviceId: "d2", deviceName: "iPhone 2", platform: "ios"))
        second.session.receive(.pairRequest)
        guard case let .error(code, _) = second.sink.sent.last else { return XCTFail("second pairing should be busy") }
        XCTAssertEqual(code, .busy)
        XCTAssertTrue(second.session.isClosed)

        // First disconnects mid-pairing: the coordinator must release, not stay busy forever.
        first.session.handleDisconnect()
        XCTAssertEqual(pairingUI.endCallCount, 1)
        XCTAssertFalse(coordinator.isPairingInProgress)

        third.session.receive(.hello(v: protocolVersion, deviceId: "d3", deviceName: "iPhone 3", platform: "ios"))
        third.session.receive(.pairRequest)
        guard case .pairPending = third.sink.sent.last else { return XCTFail("third pairing should now be free to start") }
        XCTAssertFalse(third.session.isClosed)
    }

    // MARK: - double close during pairing does not double-endPairing or crash
    //
    // Stands in for "pairing timeout fires after the session already closed": the real timer is
    // a hardcoded, non-injectable 120s deadline, so it can't be driven directly in a fast test.
    // `pairingTimedOut()`'s own guard (`case .pairingPending = phase, !isClosed`) plus this
    // `isClosed` guard on every close entry point (`fail`, wrong-pin-x3, handleDisconnect) is what
    // would protect a late-firing timer; this test exercises that exact protection through a
    // reachable trigger (a redundant disconnect signal, which NWConnection can legitimately
    // deliver more than once via overlapping `.failed`/`.cancelled` state and receive-loop errors).

    func testDoubleDisconnectDuringPairingDoesNotDoubleEndPairingOrCrash() {
        let pairingUI = FakePairingUI()
        let fixture = makeFixture(pairingUI: pairingUI)
        fixture.session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone", platform: "ios"))
        fixture.session.receive(.pairRequest)
        guard case .pairPending = fixture.sink.sent.last else { return XCTFail("pairing should start") }

        fixture.session.handleDisconnect()
        fixture.session.handleDisconnect()
        fixture.session.handleDisconnect()

        XCTAssertEqual(pairingUI.endCallCount, 1, "a redundant disconnect signal must not double-release the coordinator")
    }

    // MARK: - wrong pin twice then correct succeeds

    func testWrongPinTwiceThenCorrectPinSucceeds() {
        let pairingUI = FakePairingUI()
        let devices = FakeDeviceStore()
        let fixture = makeFixture(devices: devices, pairingUI: pairingUI)
        fixture.session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone", platform: "ios"))
        fixture.session.receive(.pairRequest)
        let correctPin = pairingUI.beganWith!.pin
        let wrongPin = correctPin == "000000" ? "111111" : "000000"

        fixture.session.receive(.pairConfirm(pin: wrongPin))
        guard case let .pairFailed(reason1) = fixture.sink.sent.last else { return XCTFail() }
        XCTAssertEqual(reason1, .wrongPin)
        XCTAssertFalse(fixture.session.isClosed)

        fixture.session.receive(.pairConfirm(pin: wrongPin))
        guard case let .pairFailed(reason2) = fixture.sink.sent.last else { return XCTFail() }
        XCTAssertEqual(reason2, .wrongPin)
        XCTAssertFalse(fixture.session.isClosed)

        fixture.session.receive(.pairConfirm(pin: correctPin))
        guard case .welcome = fixture.sink.sent.last else { return XCTFail("expected welcome after correct pin on 3rd attempt") }
        XCTAssertTrue(fixture.session.isAuthenticated)
        XCTAssertFalse(fixture.session.isClosed)
        XCTAssertNotNil(devices.secret(for: "d1"))
        XCTAssertEqual(pairingUI.endCallCount, 1)
    }

    // MARK: - cmd dedup is per device, not global

    func testCmdDedupIsPerDeviceNotGlobal() {
        let sharedDedup = CommandDedupStore()
        let textA = FakeTextInjecting()
        let textB = FakeTextInjecting()
        let fixtureA = makeFixture(text: textA, dedup: sharedDedup)
        let fixtureB = makeFixture(text: textB, dedup: sharedDedup)
        XCTAssertTrue(authenticate(fixtureA, deviceId: "device-a", secret: Data(repeating: 1, count: 32)))
        XCTAssertTrue(authenticate(fixtureB, deviceId: "device-b", secret: Data(repeating: 2, count: 32)))

        fixtureA.session.receive(.cmd(id: "shared-id", cmd: .textInsert(text: "from-a")))
        fixtureB.session.receive(.cmd(id: "shared-id", cmd: .textInsert(text: "from-b")))

        XCTAssertEqual(textA.insertedText, ["from-a"])
        XCTAssertEqual(textB.insertedText, ["from-b"], "same cmd id from a different device must execute, not dedup")
    }

    // MARK: - dedup eviction at 256 (documented as acceptable)

    func testCmdDedupEvictsAfter256AndReexecutesEvictedId() {
        let text = FakeTextInjecting()
        let fixture = makeFixture(text: text)
        XCTAssertTrue(authenticate(fixture, deviceId: "d1", secret: Data(repeating: 4, count: 32)))

        for i in 0..<300 {
            fixture.session.receive(.cmd(id: "cmd-\(i)", cmd: .textInsert(text: "t\(i)")))
        }
        XCTAssertEqual(text.insertedText.count, 300)

        // cmd-0 is the oldest of 300 ids; the 256-entry cap evicted it. Acceptable, documented
        // behavior: it re-executes instead of being treated as a duplicate.
        fixture.session.receive(.cmd(id: "cmd-0", cmd: .textInsert(text: "t0")))
        XCTAssertEqual(text.insertedText.count, 301, "an evicted id re-executes instead of deduping")
        XCTAssertEqual(text.insertedText.last, "t0")

        // A recent id (still inside the 256-entry window) must still dedup normally.
        fixture.session.receive(.cmd(id: "cmd-299", cmd: .textInsert(text: "t299")))
        XCTAssertEqual(text.insertedText.count, 301, "a recent id must still be deduped")
    }

    // MARK: - input batch of 256 events (the protocol max) when trusted

    func testInputBatchOf256EventsForwardedWhenTrusted() {
        let accessibility = FakeAccessibilityChecking()
        let input = FakeInputSink()
        let fixture = makeFixture(accessibility: accessibility, input: input)
        XCTAssertTrue(authenticate(fixture, deviceId: "d1", secret: Data(repeating: 5, count: 32)))

        let events = (0..<256).map { InputEvent.move(dx: Double($0), dy: 0, t: Double($0)) }
        fixture.session.receive(.input(events: events))
        XCTAssertEqual(input.received.count, 1)
        XCTAssertEqual(input.received.first?.count, 256)
    }

    // MARK: - agent.reply with a nil provider

    func testAgentReplyNilProviderNacksAgentCannotRespond() {
        let fixture = makeFixture(agents: nil)
        XCTAssertTrue(authenticate(fixture, deviceId: "d1", secret: Data(repeating: 6, count: 32)))

        fixture.session.receive(.cmd(id: "c1", cmd: .agentReply(sessionId: "s1", text: "hi")))
        guard case let .nack(id, error) = fixture.sink.sent.last else { return XCTFail("expected nack") }
        XCTAssertEqual(id, "c1")
        XCTAssertEqual(error.code, .agentCannotRespond)
    }

    // MARK: - provider.reply throws a non-AckError

    private final class ThrowingAgentProvider: AgentProvider {
        struct PlainError: Error {}
        var id: String = "throwing"
        var isAvailable: Bool = true
        var sessions: [AgentSession] = []
        var onChange: ((AgentProviderChange) -> Void)?
        func start() {}
        func conversation(for sessionId: String) -> [AgentMessage]? { nil }
        func reply(sessionId: String, text: String) async throws { throw PlainError() }
    }

    /// Records frames and calls `onSend` synchronously inside `send`, so a waiter can fulfill an
    /// `XCTestExpectation` the moment a frame we care about arrives, even when `send` happens on
    /// a background queue (as it does for the async `agent.reply` completion).
    private final class WaitingFrameSink: FrameSink {
        private let lock = NSLock()
        private var storage: [ServerMessage] = []
        var onSend: ((ServerMessage) -> Void)?

        var sent: [ServerMessage] {
            lock.lock(); defer { lock.unlock() }
            return storage
        }

        func send(_ message: ServerMessage) {
            lock.lock()
            storage.append(message)
            lock.unlock()
            onSend?(message)
        }
    }

    func testAgentReplyProviderThrowsNonAckErrorNacksInternal() throws {
        let sink = WaitingFrameSink()
        let devices = FakeDeviceStore()
        let secret = Data(repeating: 8, count: 32)
        devices.save(secret: secret, deviceId: "d1", deviceName: "iPhone")
        let deps = ClientSession.Dependencies(
            macName: "Test Mac", version: "1.0",
            input: FakeInputSink(), text: FakeTextInjecting(), accessibility: FakeAccessibilityChecking(),
            agents: ThrowingAgentProvider(), devices: devices, pairing: PairingCoordinator(pairingUI: FakePairingUI()),
            dedup: CommandDedupStore(), agentsTracker: AgentsDeltaTracker()
        )
        let session = ClientSession(sink: sink, deps: deps, queue: DispatchQueue(label: "qa.throwing.session"))

        session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone", platform: "ios"))
        guard case let .challenge(nonce) = sink.sent.last else { return XCTFail("expected challenge") }
        let key = SymmetricKey(data: secret)
        let proof = Data(HMAC<SHA256>.authenticationCode(for: Data(nonce.utf8), using: key)).hexString
        session.receive(.auth(proof: proof))
        guard case .welcome = sink.sent.last else { return XCTFail("expected welcome") }

        let nackReceived = expectation(description: "nack internal received")
        sink.onSend = { message in
            if case .nack = message { nackReceived.fulfill() }
        }
        session.receive(.cmd(id: "c1", cmd: .agentReply(sessionId: "s1", text: "hi")))
        wait(for: [nackReceived], timeout: 3)

        guard case let .nack(id, error) = sink.sent.last else { return XCTFail("expected nack") }
        XCTAssertEqual(id, "c1")
        XCTAssertEqual(error.code, .internalError)
    }

    // MARK: - malformed JSON while authenticated

    func testMalformedJsonWhileAuthenticatedFailsProtocolNotCrash() {
        let fixture = makeFixture()
        XCTAssertTrue(authenticate(fixture, deviceId: "d1", secret: Data(repeating: 2, count: 32)))

        fixture.session.receive(Data("not json at all {{{".utf8))
        guard case let .error(code, _) = fixture.sink.sent.last else { return XCTFail("expected protocol error") }
        XCTAssertEqual(code, .protocolError)
        XCTAssertTrue(fixture.session.isClosed)
    }

    func testUnknownDiscriminatorWhileAuthenticatedFailsProtocolNotCrash() {
        let fixture = makeFixture()
        XCTAssertTrue(authenticate(fixture, deviceId: "d1", secret: Data(repeating: 2, count: 32)))

        fixture.session.receive(Data(#"{"t":"not.a.real.message"}"#.utf8))
        guard case let .error(code, _) = fixture.sink.sent.last else { return XCTFail("expected protocol error") }
        XCTAssertEqual(code, .protocolError)
        XCTAssertTrue(fixture.session.isClosed)
    }

    // MARK: - real-socket tests

    private func startServer(deps: RelayServer.Dependencies) throws -> RelayServer {
        let server = RelayServer(config: .init(port: nil, macName: "Test Mac", version: "1.0"), deps: deps)
        let ready = expectation(description: "listening")
        server.onStateChange = { state in if case .listening = state { ready.fulfill() } }
        try server.start()
        wait(for: [ready], timeout: 5)
        return server
    }

    private func restart(_ server: RelayServer) throws {
        let ready = expectation(description: "listening again")
        server.onStateChange = { state in if case .listening = state { ready.fulfill() } }
        try server.start()
        wait(for: [ready], timeout: 5)
    }

    private func sendAndWait(_ task: URLSessionWebSocketTask, _ message: ClientMessage, file: StaticString = #filePath, line: UInt = #line) throws {
        let data = try Wire.encode(message)
        let exp = expectation(description: "sent")
        task.send(.string(String(decoding: data, as: UTF8.self))) { error in
            if let error { XCTFail("send failed: \(error)", file: file, line: line) }
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5)
    }

    private func receiveServerMessage(_ task: URLSessionWebSocketTask, file: StaticString = #filePath, line: UInt = #line) throws -> ServerMessage {
        var result: ServerMessage?
        let exp = expectation(description: "received")
        task.receive { outcome in
            switch outcome {
            case let .success(.string(text)):
                result = try? Wire.decodeServer(Data(text.utf8))
            case let .success(other):
                XCTFail("unexpected frame: \(other)", file: file, line: line)
            case let .failure(error):
                XCTFail("receive failed: \(error)", file: file, line: line)
            }
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5)
        return try XCTUnwrap(result, file: file, line: line)
    }

    private func authenticateOverSocket(_ task: URLSessionWebSocketTask, deviceId: String, secret: Data, deviceName: String = "iPhone") throws {
        try sendAndWait(task, .hello(v: protocolVersion, deviceId: deviceId, deviceName: deviceName, platform: "ios"))
        guard case let .challenge(nonce) = try receiveServerMessage(task) else {
            return XCTFail("expected challenge")
        }
        let key = SymmetricKey(data: secret)
        let proof = Data(HMAC<SHA256>.authenticationCode(for: Data(nonce.utf8), using: key)).hexString
        try sendAndWait(task, .auth(proof: proof))
        guard case .welcome = try receiveServerMessage(task) else {
            return XCTFail("expected welcome")
        }
    }

    /// A binary WebSocket frame of non-JSON garbage must be rejected the same way malformed text
    /// is (error protocol), not crash the server or hang the connection.
    func testBinaryFrameGarbageBytesGetsProtocolErrorNotCrash() throws {
        let deps = RelayServer.Dependencies(
            input: FakeInputSink(), text: FakeTextInjecting(), accessibility: FakeAccessibilityChecking(),
            agents: nil, devices: FakeDeviceStore(), pairing: FakePairingUI()
        )
        let server = try startServer(deps: deps)
        defer { server.stop() }

        let port = try XCTUnwrap(server.port)
        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)\(wsPath)")!)
        task.resume()
        defer { task.cancel(with: .normalClosure, reason: nil) }

        let garbage = Data([0xFF, 0x00, 0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02])
        let sent = expectation(description: "binary frame sent")
        task.send(.data(garbage)) { error in
            XCTAssertNil(error)
            sent.fulfill()
        }
        wait(for: [sent], timeout: 5)

        guard case let .error(code, _) = try receiveServerMessage(task) else {
            return XCTFail("expected error frame")
        }
        XCTAssertEqual(code, .protocolError)
    }

    /// stop() with an authenticated connection open, then start() again on a fresh ephemeral port,
    /// must work: the listener comes back up and a new client can hello/challenge/auth cleanly.
    func testStopWithOpenAuthenticatedConnectionThenRestartOnNewPortWorks() throws {
        let devices = FakeDeviceStore()
        let secret = Data(repeating: 3, count: 32)
        devices.save(secret: secret, deviceId: "restart-device", deviceName: "iPhone")
        let deps = RelayServer.Dependencies(
            input: FakeInputSink(), text: FakeTextInjecting(), accessibility: FakeAccessibilityChecking(),
            agents: nil, devices: devices, pairing: FakePairingUI()
        )
        let server = try startServer(deps: deps)
        let firstPort = try XCTUnwrap(server.port)

        let task1 = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(firstPort)\(wsPath)")!)
        task1.resume()
        try authenticateOverSocket(task1, deviceId: "restart-device", secret: secret)
        XCTAssertEqual(server.connectedDevices.count, 1)

        server.stop()
        XCTAssertEqual(server.connectedDevices.count, 0)
        XCTAssertNil(server.port)
        task1.cancel(with: .goingAway, reason: nil)

        try restart(server)
        defer { server.stop() }
        let secondPort = try XCTUnwrap(server.port)

        let task2 = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(secondPort)\(wsPath)")!)
        task2.resume()
        defer { task2.cancel(with: .normalClosure, reason: nil) }
        try authenticateOverSocket(task2, deviceId: "restart-device", secret: secret)
        XCTAssertEqual(server.connectedDevices.count, 1)
    }
}
