import XCTest
import RelayProtocol
@testable import RelayCore

final class AgentsDeltaTrackerTests: XCTestCase {
    private func session(id: String, status: AgentStatus, activity: String) -> AgentSession {
        AgentSession(
            id: id, provider: "claude-code", title: "t", projectPath: "/p", status: status,
            lastActivity: activity, lastActivityAt: 0, canRespond: true
        )
    }

    func testSeedDoesNotBumpRev() {
        let tracker = AgentsDeltaTracker()
        tracker.seed([session(id: "a", status: .idle, activity: "x")])
        XCTAssertEqual(tracker.rev, 0)
        XCTAssertEqual(tracker.sessions.map(\.id), ["a"])
    }

    func testApplyProducesUpsertRemoveAndIncreasingRev() {
        let tracker = AgentsDeltaTracker()
        tracker.seed([session(id: "a", status: .idle, activity: "x")])

        let changedA = session(id: "a", status: .working, activity: "y")
        let newB = session(id: "b", status: .idle, activity: "z")
        let message1 = tracker.apply([changedA, newB])
        guard case let .agentsDelta(rev1, upsert1, remove1) = message1 else { return XCTFail("expected agents.delta") }
        XCTAssertEqual(rev1, 1)
        XCTAssertEqual(Set(upsert1?.map(\.id) ?? []), Set(["a", "b"]))
        XCTAssertNil(remove1)
        XCTAssertEqual(tracker.rev, 1)

        let message2 = tracker.apply([newB])
        guard case let .agentsDelta(rev2, upsert2, remove2) = message2 else { return XCTFail("expected agents.delta") }
        XCTAssertEqual(rev2, 2)
        XCTAssertNil(upsert2)
        XCTAssertEqual(remove2, ["a"])
    }

    func testApplyWithNoChangeStillBumpsRevButEmitsNoUpsertOrRemove() {
        let tracker = AgentsDeltaTracker()
        let a = session(id: "a", status: .idle, activity: "x")
        tracker.seed([a])
        let message = tracker.apply([a])
        guard case let .agentsDelta(rev, upsert, remove) = message else { return XCTFail("expected agents.delta") }
        XCTAssertEqual(rev, 1)
        XCTAssertNil(upsert)
        XCTAssertNil(remove)
    }
}
