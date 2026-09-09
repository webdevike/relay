import CryptoKit
import XCTest
import RelayProtocol
@testable import RelayCore

final class ClientSessionTests: XCTestCase {
    private struct Fixture {
        let session: ClientSession
        let sink: FakeFrameSink
        let devices: FakeDeviceStore
        let pairingUI: FakePairingUI
        let accessibility: FakeAccessibilityChecking
        let text: FakeTextInjecting
        let input: FakeInputSink
        let agents: FakeAgentProvider?
        let agentsTracker: AgentsDeltaTracker
        let dedup: CommandDedupStore
    }

    private func makeFixture(
        devices: FakeDeviceStore = FakeDeviceStore(),
        pairingUI: FakePairingUI = FakePairingUI(),
        accessibility: FakeAccessibilityChecking = FakeAccessibilityChecking(),
        text: FakeTextInjecting = FakeTextInjecting(),
        input: FakeInputSink = FakeInputSink(),
        agents: FakeAgentProvider? = FakeAgentProvider(),
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
        let session = ClientSession(sink: sink, deps: deps, queue: DispatchQueue(label: "test.session"))
        return Fixture(
            session: session, sink: sink, devices: devices, pairingUI: pairingUI,
            accessibility: accessibility, text: text, input: input, agents: agents,
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

    // MARK: 1. hello wrong version

    func testHelloWrongVersionClosesWithVersionMismatch() {
        let fixture = makeFixture()
        fixture.session.receive(.hello(v: protocolVersion + 1, deviceId: "d1", deviceName: "iPhone", platform: "ios"))
        XCTAssertEqual(fixture.sink.sent.count, 1)
        guard case let .error(code, _) = fixture.sink.sent[0] else { return XCTFail("expected error") }
        XCTAssertEqual(code, .versionMismatch)
        XCTAssertTrue(fixture.session.isClosed)
    }

    // MARK: 2. unknown device full pairing happy path

    func testUnknownDevicePairingHappyPath() {
        let devices = FakeDeviceStore()
        let pairingUI = FakePairingUI()
        let fixture = makeFixture(devices: devices, pairingUI: pairingUI)

        fixture.session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone", platform: "ios"))
        guard case .unpaired = fixture.sink.sent.last else { return XCTFail("expected unpaired") }

        fixture.session.receive(.pairRequest)
        guard case .pairPending = fixture.sink.sent.last else { return XCTFail("expected pair.pending") }
        guard let began = pairingUI.beganWith else { return XCTFail("beginPairing not called") }
        XCTAssertEqual(began.deviceName, "iPhone")

        fixture.session.receive(.pairConfirm(pin: began.pin))
        XCTAssertEqual(fixture.sink.sent.count, 4)
        guard case let .pairOk(secretHex) = fixture.sink.sent[2] else { return XCTFail("expected pair.ok") }
        guard case .welcome = fixture.sink.sent[3] else { return XCTFail("expected welcome") }
        XCTAssertEqual(devices.secret(for: "d1")?.hexString, secretHex)
        XCTAssertEqual(pairingUI.endCallCount, 1)
        XCTAssertTrue(fixture.session.isAuthenticated)
    }

    // MARK: 3. wrong pin x3

    func testWrongPinThreeTimesTooManyAttempts() {
        let pairingUI = FakePairingUI()
        let fixture = makeFixture(pairingUI: pairingUI)
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

        fixture.session.receive(.pairConfirm(pin: wrongPin))
        guard case let .pairFailed(reason3) = fixture.sink.sent.last else { return XCTFail() }
        XCTAssertEqual(reason3, .tooManyAttempts)
        XCTAssertTrue(fixture.session.isClosed)
        XCTAssertEqual(pairingUI.endCallCount, 1)
    }

    // MARK: 4. known device challenge/auth

    func testKnownDeviceAuthSuccess() {
        let secret = Data(repeating: 7, count: 32)
        let fixture = makeFixture()
        XCTAssertTrue(authenticate(fixture, deviceId: "d1", secret: secret))
    }

    func testKnownDeviceAuthFailure() {
        let secret = Data(repeating: 7, count: 32)
        let devices = FakeDeviceStore()
        devices.save(secret: secret, deviceId: "d1", deviceName: "iPhone")
        let fixture = makeFixture(devices: devices)
        fixture.session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone", platform: "ios"))
        fixture.session.receive(.auth(proof: "00"))
        guard case let .error(code, _) = fixture.sink.sent.last else { return XCTFail() }
        XCTAssertEqual(code, .authFailed)
        XCTAssertTrue(fixture.session.isClosed)
    }

    // MARK: 5. cmd dedup

    func testCmdDedupExecutesOnceAcksTwice() {
        let text = FakeTextInjecting()
        let secret = Data(repeating: 3, count: 32)
        let fixture = makeFixture(text: text)
        XCTAssertTrue(authenticate(fixture, deviceId: "d1", secret: secret))

        fixture.session.receive(.cmd(id: "c1", cmd: .textInsert(text: "hi")))
        fixture.session.receive(.cmd(id: "c1", cmd: .textInsert(text: "hi")))

        XCTAssertEqual(text.insertedText, ["hi"])
        let acks = fixture.sink.sent.filter {
            if case let .ack(id) = $0, id == "c1" { return true }
            return false
        }
        XCTAssertEqual(acks.count, 2)
    }

    // MARK: 6. input drop/forward on accessibility

    func testInputDroppedWhenUntrustedForwardedWhenTrusted() {
        let accessibility = FakeAccessibilityChecking()
        let input = FakeInputSink()
        let secret = Data(repeating: 1, count: 32)
        let fixture = makeFixture(accessibility: accessibility, input: input)
        XCTAssertTrue(authenticate(fixture, deviceId: "d1", secret: secret))

        accessibility.isTrusted = false
        fixture.session.receive(.input(events: [.click(button: .left, t: 0)]))
        XCTAssertTrue(input.received.isEmpty)

        accessibility.isTrusted = true
        fixture.session.receive(.input(events: [.click(button: .left, t: 0)]))
        XCTAssertEqual(input.received.count, 1)
    }

    // MARK: 7 covered by AgentsDeltaTrackerTests

    // MARK: 8. frame in wrong phase

    func testFrameInWrongPhaseErrorsProtocolAndCloses() {
        let fixture = makeFixture()
        fixture.session.receive(.ping(ts: 0))
        guard case let .error(code, _) = fixture.sink.sent.last else { return XCTFail() }
        XCTAssertEqual(code, .protocolError)
        XCTAssertTrue(fixture.session.isClosed)
    }

    // MARK: extra: pairing conflict is exposed as "busy"

    func testPairingBusyWhenAnotherPairingInProgress() {
        let pairingUI = FakePairingUI()
        let coordinator = PairingCoordinator(pairingUI: pairingUI)
        let first = makeFixture(pairingUI: pairingUI, pairingCoordinator: coordinator)
        let second = makeFixture(pairingUI: pairingUI, pairingCoordinator: coordinator)

        first.session.receive(.hello(v: protocolVersion, deviceId: "d1", deviceName: "iPhone 1", platform: "ios"))
        first.session.receive(.pairRequest)
        guard case .pairPending = first.sink.sent.last else { return XCTFail("first pairing should start") }

        second.session.receive(.hello(v: protocolVersion, deviceId: "d2", deviceName: "iPhone 2", platform: "ios"))
        second.session.receive(.pairRequest)
        guard case let .error(code, _) = second.sink.sent.last else { return XCTFail("second pairing should be rejected") }
        XCTAssertEqual(code, .busy)
        XCTAssertTrue(second.session.isClosed)
        XCTAssertFalse(first.session.isClosed)
    }
}
