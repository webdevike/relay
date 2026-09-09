import Foundation
import XCTest
@testable import RelayProtocol

/// Decodes every message in packages/protocol/fixtures, re-encodes it, and checks the JSON is
/// semantically identical. This is the only thing keeping the Swift and TS schemas in lockstep.
final class FixtureConformanceTests: XCTestCase {
    private var fixturesDir: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // file
            .deletingLastPathComponent() // RelayProtocolTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // mac
            .deletingLastPathComponent() // apps
            .appendingPathComponent("packages/protocol/fixtures")
    }

    private func fixtures(_ name: String) throws -> [Data] {
        let data = try Data(contentsOf: fixturesDir.appendingPathComponent(name))
        let array = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [Any])
        return try array.map { try JSONSerialization.data(withJSONObject: $0) }
    }

    private func canonical(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    func testClientFixturesRoundTrip() throws {
        let all = try fixtures("client-messages.json")
        XCTAssertGreaterThan(all.count, 10)
        for raw in all {
            let decoded = try Wire.decodeClient(raw)
            let reencoded = try Wire.encode(decoded)
            XCTAssertEqual(try canonical(reencoded), try canonical(raw), String(decoding: raw, as: UTF8.self))
            XCTAssertEqual(try Wire.decodeClient(reencoded), decoded)
        }
    }

    func testServerFixturesRoundTrip() throws {
        let all = try fixtures("server-messages.json")
        XCTAssertGreaterThan(all.count, 10)
        for raw in all {
            let decoded = try Wire.decodeServer(raw)
            let reencoded = try Wire.encode(decoded)
            XCTAssertEqual(try canonical(reencoded), try canonical(raw), String(decoding: raw, as: UTF8.self))
            XCTAssertEqual(try Wire.decodeServer(reencoded), decoded)
        }
    }

    func testUnknownDiscriminatorsAreRejected() {
        XCTAssertThrowsError(try Wire.decodeClient(Data(#"{"t":"welcome"}"#.utf8)))
        XCTAssertThrowsError(try Wire.decodeServer(Data(#"{"t":"cmd","id":"x"}"#.utf8)))
        XCTAssertThrowsError(try Wire.decodeClient(Data(#"{"t":"input","events":[{"k":"pinch","t":1}]}"#.utf8)))
    }
}
