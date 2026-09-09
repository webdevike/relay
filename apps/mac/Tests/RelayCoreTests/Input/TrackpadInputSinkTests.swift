import CoreGraphics
@testable import RelayCore
import RelayProtocol
import XCTest

final class TrackpadInputSinkTests: XCTestCase {
    private func makeSink(poster: RecordingEventPoster) -> TrackpadInputSink {
        TrackpadInputSink(poster: poster, queue: DispatchQueue(label: "test.input"))
    }

    private func flush(_ sink: TrackpadInputSink) {
        sink.queue.sync {}
    }

    func testThreeHandleCallsBeforeDrainCoalesceIntoOnePostedMoveWithClicksInOrder() {
        let poster = RecordingEventPoster(location: CGPoint(x: 500, y: 500))
        let sink = makeSink(poster: poster)

        // Suspend the queue so all three handle() calls enqueue before any drain runs; this is
        // the scenario cross-batch coalescing exists for. Moves are kept together and the
        // clicks trail them so the assertions can distinguish "coalesced into one move" from
        // "clicks stayed in order" without one flushing the other mid-sequence.
        sink.queue.suspend()
        sink.handle([.move(dx: 1, dy: 0, t: 0)])
        sink.handle([.move(dx: 1, dy: 0, t: 8)])
        sink.handle([.move(dx: 1, dy: 0, t: 16), .click(button: .left, t: 16), .click(button: .left, t: 216)])
        sink.queue.resume()
        flush(sink)

        let moves = poster.calls.filter {
            if case .moveCursor = $0 { return true }
            return false
        }
        XCTAssertEqual(moves.count, 1, "moves across three handle() calls must coalesce into one posted move")
        guard case let .moveCursor(point)? = moves.first else { return XCTFail("expected a moveCursor call") }
        // Three unit moves, each accelerated by at least baseGain: summed delta is at least 3.
        XCTAssertGreaterThanOrEqual(point.x, 500 + 3 * PointerModel.baseGain - 1)

        let downs: [Int] = poster.calls.compactMap {
            if case let .mouseDown(_, _, count) = $0 { return count }
            return nil
        }
        XCTAssertEqual(downs, [1, 2], "clicks across batches stay ordered and keep their streak")
    }

    func testCoalescesManyMovesIntoOnePost() {
        let poster = RecordingEventPoster()
        let sink = makeSink(poster: poster)

        var events: [InputEvent] = []
        for i in 0..<50 {
            events.append(.move(dx: 1, dy: 0, t: Double(i) * 8))
        }
        sink.handle(events)
        flush(sink)

        let moves = poster.calls.filter {
            if case .moveCursor = $0 { return true }
            return false
        }
        XCTAssertEqual(moves.count, 1, "50 moves must coalesce into exactly one posted move")
    }

    func testCoalescedMoveSumsAcceleratedDeltas() {
        let poster = RecordingEventPoster(location: CGPoint(x: 500, y: 500))
        let sink = makeSink(poster: poster)

        // Slow, steady moves: gain settles near baseGain, so the summed accelerated delta is
        // close to (but not less than) the raw sum.
        let events: [InputEvent] = (0..<10).map { .move(dx: 1, dy: 0, t: Double($0) * 200) }
        sink.handle(events)
        flush(sink)

        guard case let .moveCursor(point)? = poster.calls.first else {
            return XCTFail("expected exactly one moveCursor call")
        }
        XCTAssertEqual(poster.calls.count, 1)
        XCTAssertGreaterThanOrEqual(point.x, 500 + 10 * 1.0 * PointerModel.baseGain - 1)
        XCTAssertEqual(point.y, 500)
    }

    func testMoveIsClampedToScreenBounds() {
        let poster = RecordingEventPoster(
            location: CGPoint(x: 990, y: 500),
            bounds: CGRect(x: 0, y: 0, width: 1000, height: 1000)
        )
        let sink = makeSink(poster: poster)

        sink.handle([.move(dx: 100, dy: 0, t: 8)])
        flush(sink)

        guard case let .moveCursor(point)? = poster.calls.first else {
            return XCTFail("expected a moveCursor call")
        }
        XCTAssertEqual(point.x, 1000)
    }

    func testClickCountingTwoClicksCloseInTimeAndSpace() {
        let poster = RecordingEventPoster(location: CGPoint(x: 100, y: 100))
        let sink = makeSink(poster: poster)

        sink.handle([.click(button: .left, t: 0)])
        sink.handle([.click(button: .left, t: 200)])
        flush(sink)

        let downs: [Int] = poster.calls.compactMap {
            if case let .mouseDown(_, _, count) = $0 { return count }
            return nil
        }
        XCTAssertEqual(downs, [1, 2])
    }

    func testClickCountingFarApartInTimeResets() {
        let poster = RecordingEventPoster(location: CGPoint(x: 100, y: 100))
        let sink = makeSink(poster: poster)

        sink.handle([.click(button: .left, t: 0)])
        sink.handle([.click(button: .left, t: 500)])
        flush(sink)

        let downs: [Int] = poster.calls.compactMap {
            if case let .mouseDown(_, _, count) = $0 { return count }
            return nil
        }
        XCTAssertEqual(downs, [1, 1])
    }

    func testClickCountingCloseInTimeButFarAwayResets() {
        let poster = RecordingEventPoster(location: CGPoint(x: 100, y: 100))
        let sink = makeSink(poster: poster)

        sink.handle([.click(button: .left, t: 0)])
        flush(sink)
        poster.location = CGPoint(x: 120, y: 100)
        sink.handle([.click(button: .left, t: 200)])
        flush(sink)

        let downs: [Int] = poster.calls.compactMap {
            if case let .mouseDown(_, _, count) = $0 { return count }
            return nil
        }
        XCTAssertEqual(downs, [1, 1])
    }

    func testDragStartMoveEndPostsDownDraggedUp() {
        let poster = RecordingEventPoster(location: CGPoint(x: 0, y: 0))
        let sink = makeSink(poster: poster)

        sink.handle([
            .drag(phase: .start, t: 0),
            .move(dx: 5, dy: 0, t: 8),
            .drag(phase: .end, t: 16),
        ])
        flush(sink)

        XCTAssertEqual(poster.calls.count, 3)
        guard case .mouseDown = poster.calls[0] else { return XCTFail("expected mouseDown first") }
        guard case .dragCursor = poster.calls[1] else { return XCTFail("expected dragCursor second") }
        guard case .mouseUp = poster.calls[2] else { return XCTFail("expected mouseUp third") }
    }

    func testDoubleDragStartIgnored() {
        let poster = RecordingEventPoster()
        let sink = makeSink(poster: poster)

        sink.handle([.drag(phase: .start, t: 0), .drag(phase: .start, t: 8)])
        flush(sink)

        let downs = poster.calls.filter {
            if case .mouseDown = $0 { return true }
            return false
        }
        XCTAssertEqual(downs.count, 1)
    }

    func testClickDuringDragIsIgnored() {
        let poster = RecordingEventPoster()
        let sink = makeSink(poster: poster)

        sink.handle([.drag(phase: .start, t: 0), .click(button: .left, t: 8)])
        flush(sink)

        // Only the drag's own mouseDown, nothing from the click.
        XCTAssertEqual(poster.calls.count, 1)
        guard case .mouseDown = poster.calls[0] else { return XCTFail("expected only the drag mouseDown") }
    }

    func testScrollPhaseSequencePostsExactIntegerFields() {
        let poster = RecordingEventPoster()
        let sink = makeSink(poster: poster)

        sink.handle([
            .scroll(dx: 0, dy: 10, phase: .began, t: 0),
            .scroll(dx: 0, dy: 10, phase: .changed, t: 8),
            .scroll(dx: 0, dy: 10, phase: .ended, t: 16),
            .scroll(dx: 0, dy: 5, phase: .momentum, t: 24),
            .scroll(dx: 0, dy: 5, phase: .momentum, t: 32),
            .scroll(dx: 0, dy: 0, phase: .momentumEnded, t: 40),
        ])
        flush(sink)

        let phases: [(Int32, Int32)] = poster.calls.compactMap {
            if case let .scroll(_, _, phase, momentumPhase) = $0 { return (phase, momentumPhase) }
            return nil
        }
        XCTAssertEqual(phases.map { $0.0 }, [1, 2, 4, 0, 0, 0])
        XCTAssertEqual(phases.map { $0.1 }, [0, 0, 0, 1, 2, 3])
    }
}
