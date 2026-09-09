// Fake CGEventPoster: records every call instead of touching the HID event tap. No test in this
// package may exercise SystemEventPoster.

import CoreGraphics
@testable import RelayCore
import RelayProtocol

final class RecordingEventPoster: CGEventPoster {
    enum Call: Equatable {
        case moveCursor(CGPoint)
        case dragCursor(CGPoint)
        case mouseDown(MouseButton, CGPoint, Int)
        case mouseUp(MouseButton, CGPoint, Int)
        case scroll(dx: Double, dy: Double, phase: Int32, momentumPhase: Int32)
        case typeUnicode([UInt16])
        case pressKey(UInt16)
    }

    var calls: [Call] = []
    var location: CGPoint
    var bounds: CGRect

    init(location: CGPoint = .zero, bounds: CGRect = CGRect(x: 0, y: 0, width: 2000, height: 2000)) {
        self.location = location
        self.bounds = bounds
    }

    func currentLocation() -> CGPoint { location }
    func screenBounds() -> CGRect { bounds }

    func moveCursor(to point: CGPoint) {
        calls.append(.moveCursor(point))
        location = point
    }

    func dragCursor(to point: CGPoint) {
        calls.append(.dragCursor(point))
        location = point
    }

    func mouseDown(button: MouseButton, at point: CGPoint, clickCount: Int) {
        calls.append(.mouseDown(button, point, clickCount))
    }

    func mouseUp(button: MouseButton, at point: CGPoint, clickCount: Int) {
        calls.append(.mouseUp(button, point, clickCount))
    }

    func scroll(dx: Double, dy: Double, phase: Int32, momentumPhase: Int32) {
        calls.append(.scroll(dx: dx, dy: dy, phase: phase, momentumPhase: momentumPhase))
    }

    func typeUnicode(_ units: [UInt16]) {
        calls.append(.typeUnicode(units))
    }

    func pressKey(_ keyCode: UInt16) {
        calls.append(.pressKey(keyCode))
    }
}

final class FakeAccessibility: AccessibilityChecking {
    var isTrusted: Bool
    var requestAccessCalls = 0

    init(isTrusted: Bool) {
        self.isTrusted = isTrusted
    }

    func requestAccess() {
        requestAccessCalls += 1
    }
}
