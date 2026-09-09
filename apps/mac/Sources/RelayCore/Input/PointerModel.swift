// Pure trackpad logic: acceleration, click counting, drag state, scroll phase mapping. No
// CoreGraphics posting here (see CGEventPoster) so this is exhaustively unit-testable.

import CoreGraphics
import RelayProtocol

public struct PointerModel {
    /// Acceleration curve constants. Tuned so ~0.6 pt/ms of raw speed yields ~2x gain.
    public static let baseGain = 1.2
    public static let gainSlope = 4.0 / 3.0
    public static let maxGain = 3.5

    /// Clicks within this many ms and this many points of the previous one extend the streak.
    public static let clickWindowMs = 350.0
    public static let clickDistancePoints = 6.0

    private var remainderX = 0.0
    private var remainderY = 0.0
    private var scrollRemainderX = 0.0
    private var scrollRemainderY = 0.0
    private var isDraggingState = false
    private var momentumActive = false
    private var lastClick: (button: MouseButton, point: CGPoint, t: Double, streak: Int)?

    public init() {}

    public var dragging: Bool { isDraggingState }

    /// Gain for a given raw speed (points/ms), clamped to `[1.0, maxGain]`.
    public static func gain(forSpeed speed: Double) -> Double {
        min(max(baseGain + gainSlope * speed, 1.0), maxGain)
    }

    /// Maps a raw phone delta to an accelerated screen delta. Sub-pixel remainder is carried
    /// forward rather than dropped, so many small moves still sum to the right total distance.
    public mutating func accelerate(dx: Double, dy: Double, dt: Double) -> (dx: Double, dy: Double) {
        guard dx.isFinite, dy.isFinite else { return (0, 0) }
        let safeDt = max(dt, 1.0 / 1000.0)
        let speed = (dx * dx + dy * dy).squareRoot() / safeDt
        let gain = PointerModel.gain(forSpeed: speed)
        let scaledX = dx * gain + remainderX
        let scaledY = dy * gain + remainderY
        let outX = scaledX.rounded(.towardZero)
        let outY = scaledY.rounded(.towardZero)
        remainderX = scaledX - outX
        remainderY = scaledY - outY
        return (outX, outY)
    }

    /// Clamps `point` to `bounds` (union of active display bounds). A non-finite coordinate
    /// (NaN or infinite) clamps to the bounds' nearest edge rather than propagating.
    public static func clamp(_ point: CGPoint, to bounds: CGRect) -> CGPoint {
        guard !bounds.isNull, !bounds.isEmpty else { return point }
        let x = clampCoordinate(point.x, min: bounds.minX, max: bounds.maxX)
        let y = clampCoordinate(point.y, min: bounds.minY, max: bounds.maxY)
        return CGPoint(x: x, y: y)
    }

    private static func clampCoordinate(_ value: CGFloat, min lo: CGFloat, max hi: CGFloat) -> CGFloat {
        guard value.isFinite else { return value.isNaN || value < 0 ? lo : hi }
        return min(max(value, lo), hi)
    }

    /// Returns the click state (1, 2 or 3) to post, or `nil` when the click must be ignored
    /// (a drag is in progress). Extends the streak when the previous click of the same button
    /// was recent and close; otherwise resets to 1.
    public mutating func classifyClick(button: MouseButton, at point: CGPoint, t: Double) -> Int? {
        guard !isDraggingState else { return nil }
        let streak: Int
        if let last = lastClick, last.button == button,
           (t - last.t) <= PointerModel.clickWindowMs,
           PointerModel.distance(point, last.point) <= PointerModel.clickDistancePoints {
            streak = min(last.streak + 1, 3)
        } else {
            streak = 1
        }
        lastClick = (button, point, t, streak)
        return streak
    }

    /// Starts a drag; `false` if one is already in progress (caller must ignore).
    public mutating func beginDrag() -> Bool {
        guard !isDraggingState else { return false }
        isDraggingState = true
        return true
    }

    /// Ends a drag; `false` if none was in progress (caller must ignore).
    public mutating func endDrag() -> Bool {
        guard isDraggingState else { return false }
        isDraggingState = false
        return true
    }

    /// Sub-pixel-accumulated scroll delta, scaled 1:1 into pixel units.
    public mutating func scrollDelta(dx: Double, dy: Double) -> (dx: Double, dy: Double) {
        guard dx.isFinite, dy.isFinite else { return (0, 0) }
        let scaledX = dx + scrollRemainderX
        let scaledY = dy + scrollRemainderY
        let outX = scaledX.rounded(.towardZero)
        let outY = scaledY.rounded(.towardZero)
        scrollRemainderX = scaledX - outX
        scrollRemainderY = scaledY - outY
        return (outX, outY)
    }

    /// Maps a `ScrollPhase` to the `(scrollWheelEventScrollPhase, scrollWheelEventMomentumPhase)`
    /// integer fields CGEvent expects. During momentum the regular scroll phase is 0; the first
    /// momentum event after a non-momentum one gets momentum phase "begin", later ones "continue".
    /// Any non-`.momentum` phase clears the "momentum in progress" state.
    public mutating func scrollPhaseFields(for phase: ScrollPhase) -> (scrollPhase: Int32, momentumPhase: Int32) {
        switch phase {
        case .began:
            momentumActive = false
            return (1, 0)
        case .changed:
            momentumActive = false
            return (2, 0)
        case .ended:
            momentumActive = false
            return (4, 0)
        case .momentum:
            let momentumPhase: Int32 = momentumActive ? 2 : 1
            momentumActive = true
            return (0, momentumPhase)
        case .momentumEnded:
            momentumActive = false
            return (0, 3)
        }
    }

    private static func distance(_ a: CGPoint, _ b: CGPoint) -> Double {
        let dx = a.x - b.x
        let dy = a.y - b.y
        return (dx * dx + dy * dy).squareRoot()
    }
}
