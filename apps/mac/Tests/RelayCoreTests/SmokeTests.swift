import XCTest
@testable import RelayCore

final class SmokeTests: XCTestCase {
    func testVersion() { XCTAssertFalse(relayVersion.isEmpty) }
}
