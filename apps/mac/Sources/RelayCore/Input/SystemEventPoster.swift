// The real CGEventPoster: posts into the HID event tap.

import CoreGraphics
import RelayProtocol

public final class SystemEventPoster: CGEventPoster {
    public init() {}

    public func currentLocation() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    public func screenBounds() -> CGRect {
        var displayIDs = [CGDirectDisplayID](repeating: 0, count: 32)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(UInt32(displayIDs.count), &displayIDs, &count) == .success, count > 0 else {
            return .null
        }
        var union = CGRect.null
        for i in 0..<Int(count) {
            union = union.union(CGDisplayBounds(displayIDs[i]))
        }
        return union
    }

    public func moveCursor(to point: CGPoint) {
        post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    }

    public func dragCursor(to point: CGPoint) {
        post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left))
    }

    public func mouseDown(button: MouseButton, at point: CGPoint, clickCount: Int) {
        let (type, cgButton) = SystemEventPoster.cgMouse(for: button, down: true)
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: cgButton) else { return }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        event.post(tap: .cghidEventTap)
    }

    public func mouseUp(button: MouseButton, at point: CGPoint, clickCount: Int) {
        let (type, cgButton) = SystemEventPoster.cgMouse(for: button, down: false)
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: cgButton) else { return }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        event.post(tap: .cghidEventTap)
    }

    public func scroll(dx: Double, dy: Double, phase: Int32, momentumPhase: Int32) {
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 2,
            wheel1: Int32(dy),
            wheel2: Int32(dx),
            wheel3: 0
        ) else { return }
        event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        event.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase))
        event.setIntegerValueField(.scrollWheelEventMomentumPhase, value: Int64(momentumPhase))
        event.post(tap: .cghidEventTap)
    }

    public func typeUnicode(_ units: [UInt16]) {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else { return }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        down.post(tap: .cghidEventTap)
        guard let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return }
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        up.post(tap: .cghidEventTap)
    }

    public func pressKey(_ keyCode: UInt16) {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(keyCode), keyDown: true) else { return }
        down.post(tap: .cghidEventTap)
        guard let up = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(keyCode), keyDown: false) else { return }
        up.post(tap: .cghidEventTap)
    }

    private func post(_ event: CGEvent?) {
        event?.post(tap: .cghidEventTap)
    }

    private static func cgMouse(for button: MouseButton, down: Bool) -> (CGEventType, CGMouseButton) {
        switch button {
        case .left: return (down ? .leftMouseDown : .leftMouseUp, .left)
        case .right: return (down ? .rightMouseDown : .rightMouseUp, .right)
        }
    }
}
