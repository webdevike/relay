import CoreGraphics
@testable import RelayCore
import RelayProtocol
import XCTest

final class PointerModelTests: XCTestCase {
    // MARK: Acceleration

    func testGainMonotonicInSpeed() {
        let slow = PointerModel.gain(forSpeed: 0.1)
        let medium = PointerModel.gain(forSpeed: 0.6)
        let fast = PointerModel.gain(forSpeed: 5.0)
        XCTAssertLessThan(slow, medium)
        XCTAssertLessThan(medium, fast)
    }

    func testGainRespectsBounds() {
        XCTAssertEqual(PointerModel.gain(forSpeed: 0), PointerModel.baseGain, accuracy: 1e-9)
        XCTAssertGreaterThanOrEqual(PointerModel.gain(forSpeed: 0), 1.0)
        XCTAssertEqual(PointerModel.gain(forSpeed: 1000), PointerModel.maxGain, accuracy: 1e-9)
    }

    func testGainNearTunedReferencePoint() {
        // ~0.6 pt/ms of raw speed should land close to 2x gain.
        XCTAssertEqual(PointerModel.gain(forSpeed: 0.6), 2.0, accuracy: 0.05)
    }

    func testAccelerateAccumulatesSubPixelRemainderRatherThanDropIt() {
        var model = PointerModel()
        // dt large enough that speed ~ 0 so gain sits at its floor (baseGain); every output is an
        // integer truncation of a sub-1px input, so most individual outputs would be 0 if the
        // remainder were dropped instead of carried forward.
        var total = 0.0
        var anyNonZero = false
        for _ in 0..<10 {
            let (dx, _) = model.accelerate(dx: 0.3, dy: 0, dt: 1000)
            total += dx
            if dx != 0 { anyNonZero = true }
        }
        let expectedTotal = (10 * 0.3 * PointerModel.baseGain).rounded()
        XCTAssertTrue(anyNonZero, "sub-pixel motion must not be dropped on every call")
        XCTAssertEqual(total, expectedTotal, accuracy: 1.0)
        XCTAssertGreaterThan(total, 0)
    }

    func testAccelerateHandlesNegativeDeltas() {
        var model = PointerModel()
        var total = 0.0
        for _ in 0..<10 {
            let (dx, _) = model.accelerate(dx: -0.3, dy: 0, dt: 1000)
            total += dx
        }
        XCTAssertLessThan(total, 0)
    }

    // MARK: Clamping

    func testClampKeepsPointInsideBounds() {
        let bounds = CGRect(x: 0, y: 0, width: 100, height: 100)
        XCTAssertEqual(PointerModel.clamp(CGPoint(x: -10, y: 50), to: bounds), CGPoint(x: 0, y: 50))
        XCTAssertEqual(PointerModel.clamp(CGPoint(x: 200, y: 50), to: bounds), CGPoint(x: 100, y: 50))
        XCTAssertEqual(PointerModel.clamp(CGPoint(x: 50, y: 50), to: bounds), CGPoint(x: 50, y: 50))
    }

    func testClampIsNoOpForNullBounds() {
        let point = CGPoint(x: 42, y: 7)
        XCTAssertEqual(PointerModel.clamp(point, to: .null), point)
    }

    // MARK: Click counting

    func testClickCountingWithinWindowAndDistanceExtendsStreak() {
        var model = PointerModel()
        let p = CGPoint(x: 100, y: 100)
        XCTAssertEqual(model.classifyClick(button: .left, at: p, t: 0), 1)
        XCTAssertEqual(model.classifyClick(button: .left, at: p, t: 200), 2)
    }

    func testClickCountingResetsAfterWindowExpires() {
        var model = PointerModel()
        let p = CGPoint(x: 100, y: 100)
        XCTAssertEqual(model.classifyClick(button: .left, at: p, t: 0), 1)
        XCTAssertEqual(model.classifyClick(button: .left, at: p, t: 500), 1)
    }

    func testClickCountingResetsWhenTooFarAway() {
        var model = PointerModel()
        XCTAssertEqual(model.classifyClick(button: .left, at: CGPoint(x: 100, y: 100), t: 0), 1)
        XCTAssertEqual(model.classifyClick(button: .left, at: CGPoint(x: 120, y: 100), t: 200), 1)
    }

    func testClickCountingCapsAtThree() {
        var model = PointerModel()
        let p = CGPoint(x: 0, y: 0)
        XCTAssertEqual(model.classifyClick(button: .left, at: p, t: 0), 1)
        XCTAssertEqual(model.classifyClick(button: .left, at: p, t: 100), 2)
        XCTAssertEqual(model.classifyClick(button: .left, at: p, t: 200), 3)
        XCTAssertEqual(model.classifyClick(button: .left, at: p, t: 300), 3)
    }

    func testClickCountingIgnoredWhileDragging() {
        var model = PointerModel()
        XCTAssertTrue(model.beginDrag())
        XCTAssertNil(model.classifyClick(button: .left, at: .zero, t: 0))
    }

    // MARK: Drag state machine

    func testDragStartEndLifecycle() {
        var model = PointerModel()
        XCTAssertFalse(model.dragging)
        XCTAssertTrue(model.beginDrag())
        XCTAssertTrue(model.dragging)
        XCTAssertTrue(model.endDrag())
        XCTAssertFalse(model.dragging)
    }

    func testDoubleDragStartIsIgnored() {
        var model = PointerModel()
        XCTAssertTrue(model.beginDrag())
        XCTAssertFalse(model.beginDrag())
        XCTAssertTrue(model.dragging)
    }

    func testEndDragWithoutStartIsIgnored() {
        var model = PointerModel()
        XCTAssertFalse(model.endDrag())
    }

    // MARK: Scroll

    func testScrollDeltaAccumulatesSubPixelRemainder() {
        var model = PointerModel()
        var total = 0.0
        for _ in 0..<10 {
            let (dx, _) = model.scrollDelta(dx: 0.3, dy: 0)
            total += dx
        }
        XCTAssertEqual(total, 3.0, accuracy: 1.0)
        XCTAssertGreaterThan(total, 0)
    }

    func testScrollPhaseFieldSequence() {
        var model = PointerModel()
        XCTAssertEqual(model.scrollPhaseFields(for: .began).scrollPhase, 1)
        XCTAssertEqual(model.scrollPhaseFields(for: .began).momentumPhase, 0)
        XCTAssertEqual(model.scrollPhaseFields(for: .changed).scrollPhase, 2)
        XCTAssertEqual(model.scrollPhaseFields(for: .ended).scrollPhase, 4)

        let momentum1 = model.scrollPhaseFields(for: .momentum)
        XCTAssertEqual(momentum1.scrollPhase, 0)
        XCTAssertEqual(momentum1.momentumPhase, 1)
        let momentum2 = model.scrollPhaseFields(for: .momentum)
        XCTAssertEqual(momentum2.scrollPhase, 0)
        XCTAssertEqual(momentum2.momentumPhase, 2)
        let momentumEnd = model.scrollPhaseFields(for: .momentumEnded)
        XCTAssertEqual(momentumEnd.scrollPhase, 0)
        XCTAssertEqual(momentumEnd.momentumPhase, 3)
    }
}
