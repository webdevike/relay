// relay-screen: the Relay host's window capture helper (ScreenCaptureKit). Lives inside
// "Relay Host.app" next to `relay-host`, which spawns it, so Screen Recording permission attaches
// to the app. Exit codes: 0 ok, 1 failed, 2 Screen Recording denied, 3 window gone, 64 usage.
//
//   relay-screen list                  JSON array of {id, app, title, width, height}, front to back
//   relay-screen watch <id> [fps] [w]  frames on stdout until stdin closes: per frame a 12-byte
//                                      big-endian header (jpeg length, width, height) + the JPEG.
//                                      stdin takes one JSON input command per line (see `Input`).
//   relay-screen request               asks macOS for Screen Recording access; prints true/false
import AppKit
import ApplicationServices
import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(code)
}

func deniedIfNoAccess() {
  if !CGPreflightScreenCaptureAccess() { fail(2, "screen recording permission denied") }
}

func shareable() async -> SCShareableContent {
  do {
    return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
  } catch let error as SCStreamError where error.code == .userDeclined {
    fail(2, "screen recording permission denied")
  } catch {
    fail(1, "listing windows failed: \(error.localizedDescription)")
  }
}

/// Normal app windows worth watching: layer 0, not tiny, owned by an app other than the host.
func capturable(_ content: SCShareableContent) -> [SCWindow] {
  let own = Bundle.main.bundleIdentifier ?? "com.ike.relay.host"
  let candidates = content.windows.filter { window in
    guard let app = window.owningApplication else { return false }
    return window.windowLayer == 0 && window.frame.width >= 80 && window.frame.height >= 60
      && app.bundleIdentifier != own && !app.applicationName.isEmpty
  }
  // SCShareableContent has no z-order; CGWindowList does (front to back).
  let order = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []).compactMap { $0[kCGWindowNumber as String] as? UInt32 }
  let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
  return candidates.sorted { (rank[$0.windowID] ?? .max) < (rank[$1.windowID] ?? .max) }
}

func list() async {
  deniedIfNoAccess()
  let windows = capturable(await shareable()).map { window -> [String: Any] in
    [
      "id": Int(window.windowID),
      "app": window.owningApplication?.applicationName ?? "",
      "title": window.title ?? "",
      "width": Double(window.frame.width),
      "height": Double(window.frame.height),
    ]
  }
  let json = try! JSONSerialization.data(withJSONObject: windows)
  FileHandle.standardOutput.write(json)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

final class FrameWriter: NSObject, SCStreamOutput, SCStreamDelegate {
  let windowID: CGWindowID
  let context = CIContext(options: [.cacheIntermediates: false])
  let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
  let out = FileHandle.standardOutput

  init(windowID: CGWindowID) { self.windowID = windowID }

  func stream(_: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    // Only `.complete` frames carry new pixels; `.idle` repeats mean nothing changed.
    guard type == .screen,
          let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
          let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
    let image = CIImage(cvPixelBuffer: pixels)
    let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
    guard let jpeg = context.jpegRepresentation(of: image, colorSpace: colorSpace, options: [quality: 0.55]) else { return }
    var header = Data(capacity: 12)
    for value in [UInt32(jpeg.count), UInt32(CVPixelBufferGetWidth(pixels)), UInt32(CVPixelBufferGetHeight(pixels))] {
      withUnsafeBytes(of: value.bigEndian) { header.append(contentsOf: $0) }
    }
    out.write(header + jpeg)
  }

  func stream(_: SCStream, didStopWithError error: Error) {
    Task {
      let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
      if let content, !content.windows.contains(where: { $0.windowID == self.windowID }) {
        fail(3, "window closed")
      }
      fail(1, "capture stopped: \(error.localizedDescription)")
    }
  }
}

func watch(_ id: CGWindowID, fps: Int, maxWidth: Int) async {
  deniedIfNoAccess()
  guard let window = (await shareable()).windows.first(where: { $0.windowID == id }) else { fail(3, "no window \(id)") }
  let filter = SCContentFilter(desktopIndependentWindow: window)
  let scale = Double(filter.pointPixelScale)
  let width = min(Double(maxWidth), window.frame.width * scale)
  let config = SCStreamConfiguration()
  config.width = max(2, Int(width.rounded()))
  config.height = max(2, Int((width * window.frame.height / window.frame.width).rounded()))
  config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
  config.pixelFormat = kCVPixelFormatType_32BGRA
  config.queueDepth = 3
  config.showsCursor = true
  let writer = FrameWriter(windowID: id)
  let stream = SCStream(filter: filter, configuration: config, delegate: writer)
  do {
    try stream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: DispatchQueue(label: "relay-screen.frames"))
    try await stream.startCapture()
  } catch let error as SCStreamError where error.code == .userDeclined {
    fail(2, "screen recording permission denied")
  } catch {
    fail(1, "capture failed: \(error.localizedDescription)")
  }
  // The host holds our stdin open for as long as it wants frames; EOF (or its death) ends us.
  // Meanwhile each line is an input command for the watched window.
  let input = Input(windowID: id)
  Thread.detachNewThread {
    while let line = readLine() { input.handle(line) }
    exit(0)
  }
  // Top-level code is async here, so park this task instead of calling dispatchMain().
  while true { try? await Task.sleep(nanoseconds: 3_600_000_000_000); _ = (stream, writer) }
}

/**
 * Phone input for the watched window, one JSON object per stdin line:
 * `{"t":"tap","x":0.5,"y":0.1}` (normalized over the window), `{"t":"scroll","dx":0,"dy":-40,"x":..,"y":..}`
 * (points, natural direction; at the cursor when x/y are absent), `{"t":"text","text":"hi"}`,
 * `{"t":"key","key":"return"}`, and trackpad-style `{"t":"move","dx":3,"dy":-1}` (relative, points,
 * clamped to the displays) and `{"t":"click","button":"left"|"right"}` (at the cursor).
 * Needs Accessibility (posting events); without it every command logs and is dropped.
 */
final class Input {
  let windowID: CGWindowID
  static let keyCodes: [String: CGKeyCode] = [
    "return": 36, "tab": 48, "delete": 51, "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126,
  ]

  init(windowID: CGWindowID) { self.windowID = windowID }

  func handle(_ line: String) {
    guard let json = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          let kind = json["t"] as? String else { return log("bad input line") }
    guard AXIsProcessTrusted() else { return log("accessibility permission denied; input dropped") }
    // Trackpad input acts wherever the cursor is, like a real trackpad: no window lookup or focus.
    if kind == "move" { return move(dx: (json["dx"] as? Double) ?? 0, dy: (json["dy"] as? Double) ?? 0) }
    if kind == "click" { return click(right: (json["button"] as? String) == "right") }
    if kind == "scroll", json["x"] == nil || json["y"] == nil {
      return scroll(at: cursor(), dx: (json["dx"] as? Double) ?? 0, dy: (json["dy"] as? Double) ?? 0)
    }
    guard let (bounds, pid) = windowInfo() else { return log("window \(windowID) gone; input dropped") }
    focus(pid: pid, bounds: bounds)
    let at = { (x: Any?, y: Any?) -> CGPoint in
      let nx = (x as? Double) ?? 0.5, ny = (y as? Double) ?? 0.5
      return CGPoint(x: bounds.minX + bounds.width * min(max(nx, 0), 1), y: bounds.minY + bounds.height * min(max(ny, 0), 1))
    }
    switch kind {
    case "tap":
      let point = at(json["x"], json["y"])
      post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
      post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left))
      post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
    case "scroll":
      // Scroll goes to the window under the pointer, so park the pointer over ours first.
      let point = at(json["x"], json["y"])
      post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
      scroll(at: point, dx: (json["dx"] as? Double) ?? 0, dy: (json["dy"] as? Double) ?? 0)
    case "text":
      guard let text = json["text"] as? String else { return }
      // keyboardSetUnicodeString carries at most ~20 UTF-16 units per event.
      let units = Array(text.utf16)
      for start in stride(from: 0, to: units.count, by: 16) {
        let chunk = Array(units[start..<min(start + 16, units.count)])
        for down in [true, false] {
          let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
          event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
          post(event)
        }
      }
    case "key":
      guard let name = json["key"] as? String, let code = Input.keyCodes[name] else { return log("unknown key") }
      post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true))
      post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false))
    default:
      log("unknown input \(kind)")
    }
  }

  func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

  /// Relative pointer move, clamped to the union of all displays (top-left origin, CGEvent space).
  func move(dx: Double, dy: Double) {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    CGGetActiveDisplayList(16, &ids, &count)
    let screens = ids.prefix(Int(count)).map { CGDisplayBounds($0) }
    let target = CGPoint(x: cursor().x + dx, y: cursor().y + dy)
    // Stay on the display containing the target, else pull back onto the nearest one.
    let clamped = screens.contains(where: { $0.contains(target) }) ? target : screens.map { bounds in
      CGPoint(x: min(max(target.x, bounds.minX), bounds.maxX - 1), y: min(max(target.y, bounds.minY), bounds.maxY - 1))
    }.min { hypot($0.x - target.x, $0.y - target.y) < hypot($1.x - target.x, $1.y - target.y) } ?? target
    let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: clamped, mouseButton: .left)
    event?.setIntegerValueField(.mouseEventDeltaX, value: Int64(dx.rounded()))
    event?.setIntegerValueField(.mouseEventDeltaY, value: Int64(dy.rounded()))
    event?.post(tap: .cghidEventTap)
  }

  func click(right: Bool) {
    let point = cursor()
    let button: CGMouseButton = right ? .right : .left
    post(CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: point, mouseButton: button))
    post(CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: point, mouseButton: button))
  }

  func scroll(at point: CGPoint, dx: Double, dy: Double) {
    let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0)
    event?.location = point
    post(event)
  }

  /// Global bounds (top-left origin, the CGEvent space) and owner pid of the watched window, now.
  func windowInfo() -> (CGRect, pid_t)? {
    guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]])?.first,
          let dict = info[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: dict),
          let pid = info[kCGWindowOwnerPID as String] as? pid_t else { return nil }
    return (bounds, pid)
  }

  /// Brings the app forward and raises the AX window matching `bounds`, so input lands in it.
  func focus(pid: pid_t, bounds: CGRect) {
    let app = NSRunningApplication(processIdentifier: pid)
    let wasActive = app?.isActive ?? false
    if !wasActive { app?.activate() }
    let axApp = AXUIElementCreateApplication(pid)
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &value) == .success,
       let windows = value as? [AXUIElement] {
      let match = windows.first { window in
        var pos: CFTypeRef?, size: CFTypeRef?
        var p = CGPoint.zero, s = CGSize.zero
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &pos) == .success,
              AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
              let posValue = pos, let sizeValue = size,
              AXValueGetValue(posValue as! AXValue, .cgPoint, &p), AXValueGetValue(sizeValue as! AXValue, .cgSize, &s) else { return false }
        return abs(p.x - bounds.minX) < 2 && abs(p.y - bounds.minY) < 2 && abs(s.width - bounds.width) < 2 && abs(s.height - bounds.height) < 2
      }
      if let match { AXUIElementPerformAction(match, kAXRaiseAction as CFString) }
    }
    // Give the window server a beat to deliver focus before the first event.
    if !wasActive { usleep(120_000) }
  }

  func post(_ event: CGEvent?) {
    event?.post(tap: .cghidEventTap)
    usleep(8_000)
  }

  func log(_ message: String) {
    FileHandle.standardError.write(Data("input: \(message)\n".utf8))
  }
}


// Screen Recording is granted to the "responsible" process, which for anything launchd starts is
// the ad-hoc signed daemon (a new identity every build). Re-exec once with responsibility
// disclaimed so macOS checks this helper's own stable signature instead: one grant, kept across
// rebuilds, listed as relay-screen.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32
var disclaimedChild: pid_t = 0
if getenv("RELAY_SCREEN_DISCLAIMED") == nil {
  setenv("RELAY_SCREEN_DISCLAIMED", "1", 1)
  var attrs: posix_spawnattr_t?
  posix_spawnattr_init(&attrs)
  _ = responsibility_spawnattrs_setdisclaim(&attrs, 1)
  let path = Bundle.main.executablePath ?? CommandLine.arguments[0]
  let rc = posix_spawn(&disclaimedChild, path, nil, &attrs, CommandLine.unsafeArgv, environ)
  if rc != 0 { fail(1, "spawn failed: \(String(cString: strerror(rc)))") }
  for sig in [SIGTERM, SIGINT, SIGHUP] { signal(sig) { kill(disclaimedChild, $0) } }
  var status: Int32 = 0
  while waitpid(disclaimedChild, &status, 0) == -1 && errno == EINTR {}
  exit(status & 0x7f == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f))
}

signal(SIGPIPE, SIG_DFL)
// SCStream needs a WindowServer connection (CGS) that plain CLI tools never open; AppKit makes one.
_ = NSApplication.shared
let args = CommandLine.arguments.dropFirst()
switch args.first {
case "list":
  await list()
case "watch":
  guard let raw = args.dropFirst().first, let id = UInt32(raw) else { fail(64, "usage: relay-screen watch <windowId> [fps] [maxWidth]") }
  let fps = args.dropFirst(2).first.flatMap { Int($0) } ?? 10
  let maxWidth = args.dropFirst(3).first.flatMap { Int($0) } ?? 1170
  await watch(CGWindowID(id), fps: fps, maxWidth: maxWidth)
case "request":
  print(CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess())
default:
  fail(64, "usage: relay-screen list | watch <windowId> [fps] [maxWidth] | request")
}
