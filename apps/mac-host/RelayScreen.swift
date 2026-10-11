// relay-screen: the Relay host's window capture helper (ScreenCaptureKit). Lives inside
// "Relay Host.app" next to `relay-host`, which spawns it, so Screen Recording permission attaches
// to the app. Exit codes: 0 ok, 1 failed, 2 Screen Recording denied, 3 window gone, 64 usage.
//
//   relay-screen list                  JSON array of {id, app, title, width, height}, front to back
//   relay-screen watch <id> [fps] [w]  frames on stdout until stdin closes: per frame a 12-byte
//                                      big-endian header (jpeg length, width, height) + the JPEG
//   relay-screen request               asks macOS for Screen Recording access; prints true/false
import AppKit
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
  DispatchQueue.global().async {
    while !FileHandle.standardInput.availableData.isEmpty {}
    exit(0)
  }
  // Top-level code is async here, so park this task instead of calling dispatchMain().
  while true { try? await Task.sleep(nanoseconds: 3_600_000_000_000); _ = (stream, writer) }
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
