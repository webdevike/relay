// Turns ephemeral phone trackpad events into CGEvents. Runs on its own serial queue so the
// transport's `handle(_:)` call is always cheap and never blocks on event posting.

import Foundation
import RelayProtocol

public final class TrackpadInputSink: InputSink {
    let queue: DispatchQueue

    private let poster: CGEventPoster
    private var model = PointerModel()
    private var lastMoveT: Double?

    /// `handle(_:)` must be cheap and never drop input (Seams.swift): batches accumulate here
    /// under `lock` and at most one drain is ever scheduled on `queue`, so a burst of calls
    /// coalesces into one processing pass instead of piling up unbounded work on the queue.
    private let lock = NSLock()
    private var pending: [InputEvent] = []
    private var drainScheduled = false

    public init(poster: CGEventPoster, queue: DispatchQueue = DispatchQueue(label: "com.relay.input")) {
        self.poster = poster
        self.queue = queue
    }

    public func handle(_ events: [InputEvent]) {
        lock.lock()
        pending.append(contentsOf: events)
        let needsSchedule = !drainScheduled
        drainScheduled = true
        lock.unlock()

        guard needsSchedule else { return }
        queue.async { [self] in drain() }
    }

    private func drain() {
        lock.lock()
        let events = pending
        pending = []
        drainScheduled = false
        lock.unlock()
        process(events)
    }

    private func process(_ events: [InputEvent]) {
        var pendingDX = 0.0
        var pendingDY = 0.0
        var hasPending = false

        func flushMove() {
            guard hasPending else { return }
            let current = poster.currentLocation()
            let target = PointerModel.clamp(
                CGPoint(x: current.x + pendingDX, y: current.y + pendingDY),
                to: poster.screenBounds()
            )
            if model.dragging {
                poster.dragCursor(to: target)
            } else {
                poster.moveCursor(to: target)
            }
            pendingDX = 0
            pendingDY = 0
            hasPending = false
        }

        for event in events {
            switch event {
            case let .move(dx, dy, t):
                let dt = lastMoveT.map { t - $0 } ?? 8
                lastMoveT = t
                let (adx, ady) = model.accelerate(dx: dx, dy: dy, dt: dt)
                pendingDX += adx
                pendingDY += ady
                hasPending = true

            case let .click(button, t):
                flushMove()
                let point = poster.currentLocation()
                guard let clickCount = model.classifyClick(button: button, at: point, t: t) else { continue }
                poster.mouseDown(button: button, at: point, clickCount: clickCount)
                poster.mouseUp(button: button, at: point, clickCount: clickCount)

            case let .drag(phase, _):
                flushMove()
                let point = poster.currentLocation()
                switch phase {
                case .start:
                    guard model.beginDrag() else { continue }
                    poster.mouseDown(button: .left, at: point, clickCount: 1)
                case .end:
                    guard model.endDrag() else { continue }
                    poster.mouseUp(button: .left, at: point, clickCount: 1)
                }

            case let .scroll(dx, dy, phase, _):
                flushMove()
                let (sdx, sdy) = model.scrollDelta(dx: dx, dy: dy)
                let (scrollPhase, momentumPhase) = model.scrollPhaseFields(for: phase)
                poster.scroll(dx: sdx, dy: sdy, phase: scrollPhase, momentumPhase: momentumPhase)
            }
        }
        flushMove()
    }
}
