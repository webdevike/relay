// The only seam between pointer/keyboard logic and CoreGraphics. TrackpadInputSink and
// KeyboardInjector compute *what* to post against `PointerModel`; everything here is *how* to
// post it, so tests can swap in a recording fake and never touch the real HID event tap.

import CoreGraphics
import RelayProtocol

public protocol CGEventPoster: AnyObject {
    /// Current cursor location in global (screen) coordinates.
    func currentLocation() -> CGPoint
    /// Bounding rect a cursor may occupy: union of all active display bounds.
    func screenBounds() -> CGRect

    func moveCursor(to point: CGPoint)
    func dragCursor(to point: CGPoint)
    func mouseDown(button: MouseButton, at point: CGPoint, clickCount: Int)
    func mouseUp(button: MouseButton, at point: CGPoint, clickCount: Int)
    /// `phase`/`momentumPhase` are the raw `scrollWheelEventScrollPhase` /
    /// `scrollWheelEventMomentumPhase` integer field values; see `PointerModel.scrollPhaseFields`.
    func scroll(dx: Double, dy: Double, phase: Int32, momentumPhase: Int32)

    /// Posts `units` (UTF-16) as a single keyDown+keyUp unicode-string key event (virtual key 0).
    func typeUnicode(_ units: [UInt16])
    /// Posts a keyDown+keyUp for a real virtual key code (return, escape, backspace, tab, ...).
    func pressKey(_ keyCode: UInt16)
}
