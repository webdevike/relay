import XCTest
import RelayProtocol
@testable import RelayCore

final class CommandDedupStoreTests: XCTestCase {
    /// Proves the atomicity contract directly: a second `begin` for the same id while the first
    /// is still in flight must not report `.fresh` (which would re-execute), and `complete`
    /// notifies the waiter that arrived while in flight.
    func testInFlightDuplicateDoesNotReexecuteAndWaiterIsNotifiedOnComplete() {
        let store = CommandDedupStore()
        let original = FakeFrameSink()
        let duplicate = FakeFrameSink()

        guard case .fresh = store.begin(deviceId: "d1", id: "c1", waiter: original) else {
            return XCTFail("first begin should be fresh")
        }
        guard case .inFlight = store.begin(deviceId: "d1", id: "c1", waiter: duplicate) else {
            return XCTFail("second begin while in flight must not be fresh")
        }

        XCTAssertTrue(original.sent.isEmpty)
        XCTAssertTrue(duplicate.sent.isEmpty)

        store.complete(deviceId: "d1", id: "c1", response: .ack(id: "c1"))

        XCTAssertEqual(duplicate.sent, [.ack(id: "c1")])
        XCTAssertTrue(original.sent.isEmpty, "complete notifies waiters, not the original caller")
    }

    func testCompletedLookupResendsCachedResponse() {
        let store = CommandDedupStore()
        let original = FakeFrameSink()
        let late = FakeFrameSink()

        guard case .fresh = store.begin(deviceId: "d1", id: "c1", waiter: original) else {
            return XCTFail("expected fresh")
        }
        store.complete(deviceId: "d1", id: "c1", response: .ack(id: "c1"))

        guard case let .completed(response) = store.begin(deviceId: "d1", id: "c1", waiter: late) else {
            return XCTFail("expected completed")
        }
        XCTAssertEqual(response, .ack(id: "c1"))
    }
}
