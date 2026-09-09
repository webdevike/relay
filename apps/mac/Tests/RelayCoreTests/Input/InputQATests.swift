// Adversarial coverage beyond the primary suites: dt edge cases, NaN/Infinity boundaries that
// stay safe, clamping at display edges, click/drag/scroll state-machine edges, coalescing order,
// and KeyboardInjector edge inputs. See the QA report for confirmed bugs that are deliberately
// NOT defended here (they fail against the current implementation).
import CoreGraphics
@testable import RelayCore
import RelayProtocol
import XCTest

final class QATests: XCTestCase {
    private func makeSink(poster: RecordingEventPoster) -> TrackpadInputSink {
        TrackpadInputSink(poster: poster, queue: DispatchQueue(label: "qa.tests"))
    }
    private func flush(_ sink: TrackpadInputSink) {
        sink.queue.sync {}
    }

    // MARK: - dt edge cases

    func testAccelerateZeroDeltaZeroDtDoesNotDivideByZero() {
        var model = PointerModel()
        let (dx, dy) = model.accelerate(dx: 0, dy: 0, dt: 0)
        XCTAssertEqual(dx, 0)
        XCTAssertEqual(dy, 0)
    }

    func testAccelerateZeroAndNegativeDtClampToSameFloor() {
        var zeroModel = PointerModel()
        let zero = zeroModel.accelerate(dx: 5, dy: -5, dt: 0)

        var smallNegModel = PointerModel()
        let smallNeg = smallNegModel.accelerate(dx: 5, dy: -5, dt: -1)

        var bigNegModel = PointerModel()
        let bigNeg = bigNegModel.accelerate(dx: 5, dy: -5, dt: -100_000)

        XCTAssertTrue(zero.dx.isFinite && zero.dy.isFinite)
        XCTAssertEqual(zero.dx, smallNeg.dx)
        XCTAssertEqual(zero.dy, smallNeg.dy)
        XCTAssertEqual(zero.dx, bigNeg.dx)
        XCTAssertEqual(zero.dy, bigNeg.dy)
    }

    func testAccelerateHugeDtAfterReconnectGapActsLikeSlowMove() {
        // A multi-minute gap (e.g. a dropped connection) must not be mistaken for a fast swipe.
        var model = PointerModel()
        let (dx, _) = model.accelerate(dx: 10, dy: 0, dt: 120_000)
        XCTAssertTrue(dx.isFinite)
        XCTAssertEqual(dx, 10 * PointerModel.baseGain, accuracy: 0.01)
    }

    func testAccelerateRemainderDoesNotRunawayAcrossDirectionReversals() {
        var model = PointerModel()
        var cumulativeOutput = 0.0
        var cumulativeIdeal = 0.0
        for i in 0..<400 {
            let raw = (i % 2 == 0) ? 0.4 : -0.4
            let gain = PointerModel.gain(forSpeed: abs(raw) / 1000)
            let (dx, _) = model.accelerate(dx: raw, dy: 0, dt: 1000)
            cumulativeOutput += dx
            cumulativeIdeal += raw * gain
            XCTAssertLessThan(abs(cumulativeOutput - cumulativeIdeal), 1.0, "remainder ran away at step \(i)")
        }
    }

    // MARK: - Clamping

    func testClampPullsPointFarOutsideEveryDisplayBackToNearestCorner() {
        let bounds = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        XCTAssertEqual(PointerModel.clamp(CGPoint(x: -50_000, y: -50_000), to: bounds), CGPoint(x: 0, y: 0))
        XCTAssertEqual(PointerModel.clamp(CGPoint(x: 50_000, y: 50_000), to: bounds), CGPoint(x: 1920, y: 1080))
        XCTAssertEqual(PointerModel.clamp(CGPoint(x: -50_000, y: 50_000), to: bounds), CGPoint(x: 0, y: 1080))
    }

    func testClampHandlesNegativeOriginMultiDisplayUnion() {
        // Two displays of different heights side by side: the union is a single bounding rect
        // (matches real macOS multi-display cursor confinement, dead zones included).
        let displayA = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let displayB = CGRect(x: 1920, y: -200, width: 1280, height: 1400)
        let union = displayA.union(displayB)
        XCTAssertEqual(union, CGRect(x: 0, y: -200, width: 3200, height: 1400))

        XCTAssertEqual(PointerModel.clamp(CGPoint(x: -10, y: -300), to: union), CGPoint(x: 0, y: -200))
        XCTAssertEqual(PointerModel.clamp(CGPoint(x: 5000, y: 5000), to: union), CGPoint(x: 3200, y: 1200))
        let deadZonePoint = CGPoint(x: 2500, y: 1150)
        XCTAssertEqual(PointerModel.clamp(deadZonePoint, to: union), deadZonePoint)
    }

    func testCursorStartingOutsideBoundsIsClampedBackIn() {
        // The reported cursor location can be outside the current display union (e.g. a display
        // was unplugged). The very next move must still land inside bounds.
        let poster = RecordingEventPoster(
            location: CGPoint(x: -9999, y: -9999),
            bounds: CGRect(x: 0, y: 0, width: 1000, height: 1000)
        )
        let sink = makeSink(poster: poster)

        sink.handle([.move(dx: 1, dy: 1, t: 8)])
        flush(sink)

        guard case let .moveCursor(point)? = poster.calls.first else {
            return XCTFail("expected a moveCursor call")
        }
        XCTAssertGreaterThanOrEqual(point.x, 0)
        XCTAssertGreaterThanOrEqual(point.y, 0)
        XCTAssertLessThanOrEqual(point.x, 1000)
        XCTAssertLessThanOrEqual(point.y, 1000)
    }

    // MARK: - Click streak precedence

    func testClickStreakResetsAfterDifferentButtonClickBreaksIt() {
        var model = PointerModel()
        let p = CGPoint(x: 100, y: 100)
        XCTAssertEqual(model.classifyClick(button: .left, at: p, t: 0), 1)
        XCTAssertEqual(model.classifyClick(button: .left, at: p, t: 100), 2)
        // A right click close in time/space breaks the left streak.
        XCTAssertEqual(model.classifyClick(button: .right, at: p, t: 150), 1)
        // The next left click, even though close to the ORIGINAL left clicks, restarts at 1
        // because the most recent click was a different button.
        XCTAssertEqual(model.classifyClick(button: .left, at: p, t: 200), 1)
    }

    // MARK: - Drag lifecycle

    func testDragEndWithoutStartPostsNothing() {
        let poster = RecordingEventPoster()
        let sink = makeSink(poster: poster)

        sink.handle([.drag(phase: .end, t: 0)])
        flush(sink)

        XCTAssertTrue(poster.calls.isEmpty, "drag end with no prior start must post nothing")
    }

    func testDoubleDragStartThenEndPostsExactlyOneDownOneUp() {
        let poster = RecordingEventPoster(location: CGPoint(x: 10, y: 10))
        let sink = makeSink(poster: poster)

        sink.handle([
            .drag(phase: .start, t: 0),
            .drag(phase: .start, t: 8),
            .drag(phase: .end, t: 16),
        ])
        flush(sink)

        XCTAssertEqual(poster.calls, [
            .mouseDown(.left, CGPoint(x: 10, y: 10), 1),
            .mouseUp(.left, CGPoint(x: 10, y: 10), 1),
        ])
    }

    // MARK: - Scroll momentum state

    func testMomentumWithoutPriorBeganStartsAtBegin() {
        // A dropped batch can plausibly deliver a bare momentum event first.
        var model = PointerModel()
        let m = model.scrollPhaseFields(for: .momentum)
        XCTAssertEqual(m.scrollPhase, 0)
        XCTAssertEqual(m.momentumPhase, 1)
    }

    func testMomentumEndedTwiceThenMomentumStartsFresh() {
        var model = PointerModel()
        _ = model.scrollPhaseFields(for: .momentum)
        _ = model.scrollPhaseFields(for: .momentumEnded)
        let second = model.scrollPhaseFields(for: .momentumEnded)
        XCTAssertEqual(second.momentumPhase, 3)
        let fresh = model.scrollPhaseFields(for: .momentum)
        XCTAssertEqual(fresh.momentumPhase, 1)
    }

    // MARK: - 256-event mixed batch ordering

    func testMixedBatchCoalescingPreservesOrderAroundClicksAndScrolls() {
        let poster = RecordingEventPoster(location: CGPoint(x: 500, y: 500))
        let sink = makeSink(poster: poster)

        var events: [InputEvent] = []
        var t = 0.0
        for _ in 0..<120 {
            events.append(.move(dx: 1, dy: 0, t: t)); t += 8
        }
        events.append(.click(button: .left, t: t)); t += 8
        for _ in 0..<100 {
            events.append(.move(dx: 1, dy: 0, t: t)); t += 8
        }
        events.append(.scroll(dx: 0, dy: 1, phase: .began, t: t)); t += 8
        for _ in 0..<34 {
            events.append(.move(dx: 1, dy: 0, t: t)); t += 8
        }
        XCTAssertEqual(events.count, 256)

        sink.handle(events)
        flush(sink)

        func kind(_ c: RecordingEventPoster.Call) -> String {
            switch c {
            case .moveCursor: return "move"
            case .dragCursor: return "drag"
            case .mouseDown: return "down"
            case .mouseUp: return "up"
            case .scroll: return "scroll"
            case .typeUnicode: return "unicode"
            case .pressKey: return "key"
            }
        }
        // 120 moves coalesce into one post, then the click (down+up), then 100 moves coalesce
        // into one post, then the scroll, then the trailing 34 moves coalesce into one post: the
        // click and scroll must never be reordered relative to the moves around them.
        XCTAssertEqual(poster.calls.map(kind), ["move", "down", "up", "move", "scroll", "move"])
    }

    func testBurstOfHandleCallsBeforeDrainStillPreservesOrderAroundClicksAndScrolls() {
        // handle() coalesces across separate calls when they outrun the drain (see
        // TrackpadInputSink's pending/drainScheduled buffer): suspend the queue so several
        // handle() calls enqueue before any drain runs, then confirm the merged batch still
        // never reorders a click/scroll relative to the moves around it.
        let poster = RecordingEventPoster(location: CGPoint(x: 500, y: 500))
        let sink = makeSink(poster: poster)

        sink.queue.suspend()
        var t = 0.0
        for _ in 0..<40 {
            sink.handle([.move(dx: 1, dy: 0, t: t)]); t += 8
        }
        sink.handle([.click(button: .left, t: t)]); t += 8
        for _ in 0..<40 {
            sink.handle([.move(dx: 1, dy: 0, t: t)]); t += 8
        }
        sink.handle([.scroll(dx: 0, dy: 1, phase: .began, t: t)]); t += 8
        for _ in 0..<40 {
            sink.handle([.move(dx: 1, dy: 0, t: t)]); t += 8
        }
        sink.queue.resume()
        flush(sink)

        func kind(_ c: RecordingEventPoster.Call) -> String {
            switch c {
            case .moveCursor: return "move"
            case .dragCursor: return "drag"
            case .mouseDown: return "down"
            case .mouseUp: return "up"
            case .scroll: return "scroll"
            case .typeUnicode: return "unicode"
            case .pressKey: return "key"
            }
        }
        XCTAssertEqual(poster.calls.map(kind), ["move", "down", "up", "move", "scroll", "move"])
    }

    // MARK: - KeyboardInjector edge inputs

    func testInsertEmptyStringPostsNothing() throws {
        let poster = RecordingEventPoster()
        let accessibility = FakeAccessibility(isTrusted: true)
        let injector = KeyboardInjector(poster: poster, accessibility: accessibility)

        try injector.insert("")

        XCTAssertTrue(poster.calls.isEmpty)
    }

    func testInsertOnlyNewlinesPostsReturnsAndNoUnicodeChunks() throws {
        let poster = RecordingEventPoster()
        let accessibility = FakeAccessibility(isTrusted: true)
        let injector = KeyboardInjector(poster: poster, accessibility: accessibility)

        try injector.insert("\n\n\n")

        XCTAssertEqual(poster.calls, [.pressKey(36), .pressKey(36), .pressKey(36)])
    }
}
