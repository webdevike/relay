import Foundation
import XCTest
import RelayProtocol
@testable import RelayCore

/// Socket-level smoke test: proves the listener + WebSocket upgrade + framing + Bonjour
/// registration work end to end with a standard client. Does not assert Bonjour resolution.
final class RelayServerSmokeTests: XCTestCase {
    func testHelloReceivesUnpairedOverRealSocket() throws {
        let deps = RelayServer.Dependencies(
            input: FakeInputSink(), text: FakeTextInjecting(), accessibility: FakeAccessibilityChecking(),
            agents: nil, devices: FakeDeviceStore(), pairing: FakePairingUI()
        )
        let server = RelayServer(config: .init(port: nil, macName: "Test Mac", version: "1.0"), deps: deps)

        let ready = expectation(description: "server listening")
        server.onStateChange = { state in
            if case .listening = state { ready.fulfill() }
        }
        try server.start()
        wait(for: [ready], timeout: 5)
        defer { server.stop() }

        let port = try XCTUnwrap(server.port)
        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)\(wsPath)")!)
        task.resume()
        defer { task.cancel(with: .normalClosure, reason: nil) }

        let hello = ClientMessage.hello(v: protocolVersion, deviceId: "smoke-device", deviceName: "Smoke iPhone", platform: "ios")
        let sent = expectation(description: "sent")
        task.send(.string(String(decoding: try Wire.encode(hello), as: UTF8.self))) { error in
            XCTAssertNil(error)
            sent.fulfill()
        }
        wait(for: [sent], timeout: 5)

        let received = expectation(description: "received unpaired")
        task.receive { result in
            switch result {
            case let .success(.string(text)):
                if let message = try? Wire.decodeServer(Data(text.utf8)), case .unpaired = message {
                    received.fulfill()
                } else {
                    XCTFail("unexpected frame: \(text)")
                }
            case let .success(other):
                XCTFail("unexpected frame: \(other)")
            case let .failure(error):
                XCTFail("receive failed: \(error)")
            }
        }
        wait(for: [received], timeout: 5)
    }
}
