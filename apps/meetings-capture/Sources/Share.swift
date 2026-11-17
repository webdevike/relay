// Screen-share snapshots: someone shares their screen in the call, Relay asks for a sample every
// few seconds and keeps the ones that changed (apps/desktop/src/main decides; this file does the
// seeing).
//
// Detection rides on the speaker watch's window walk (Speakers.swift). The shared content's
// labels in Teams 2 are not known yet (no AX dump of a share was taken), so the rule is
// conservative: an element that is not a control (button, menu item, checkbox, tab, text) whose
// label, description, DOM id or classes name a screen share or someone presenting, at least
// 320x180 pt. When several match (a stage around the content), the smallest big enough one is the
// content. The first match of each share is logged as a warning, so the first real share says what
// matched.
//
// Capture is of that region only, from the meeting app's window (ScreenCaptureKit with a
// desktop-independent window filter and a source rect), never the whole screen, and only once
// Relay already holds Screen Recording: `CGPreflightScreenCaptureAccess()` is the only check and
// nothing here ever asks for it. A sample is hashed (256-bit dHash) so Relay can tell a new slide
// from the same one; a save runs Vision OCR and writes a JPEG into the spool.
import AppKit
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

/// Where the shared content is: global points with a top-left origin (Accessibility and
/// ScreenCaptureKit agree on these), and the process whose window shows it.
struct ShareRegion: Equatable {
  var rect: CGRect
  var pid: pid_t
}

struct ShareError: Error {
  var reason: String
}

enum ShareParse {
  /// Smaller than this is a label or a toolbar ("You're presenting"), not the content.
  static let minSize = CGSize(width: 320, height: 180)
  static let phrases = [
    "screen shar", "screenshar", "screen-share", "content shar", "content-share", "shared content",
    "shared screen", "sharing content", "presenting",
  ]
  /// Controls and text: a "Stop presenting" button or an "is presenting" line is never the content.
  static let skippedRoles: Set<String> = [
    "AXButton", "AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXPopUpButton", "AXCheckBox",
    "AXRadioButton", "AXTab", "AXTabGroup", "AXLink", "AXStaticText", "AXTextField", "AXTextArea",
    "AXHeading", "AXToolbar", "AXMenu", "AXMenuBar",
  ]

  /// Whether the node's words say it is shared content (size is checked apart: it needs the frame).
  static func matches(_ n: AXNode) -> Bool {
    guard !n.role.isEmpty, !skippedRoles.contains(n.role) else { return false }
    let hay = ([n.title, n.desc, n.ident] + n.classes).joined(separator: " ").lowercased()
    return phrases.contains { hay.contains($0) }
  }

  static func bigEnough(_ frame: CGRect) -> Bool {
    frame.width >= minSize.width && frame.height >= minSize.height
  }

  /// The candidate to capture: the smallest big enough frame (the content, not the stage around it).
  static func pick(_ frames: [CGRect]) -> Int? {
    frames.indices.filter { bigEnough(frames[$0]) }.min { area(frames[$0]) < area(frames[$1]) }
  }

  /// What matched, for the log.
  static func describe(_ n: AXNode, frame: CGRect) -> String {
    var parts = ["share: matched \(n.role)"]
    if !n.subrole.isEmpty { parts.append("subrole \(n.subrole)") }
    if !n.title.isEmpty { parts.append("title \"\(n.title)\"") }
    if !n.desc.isEmpty { parts.append("desc \"\(n.desc)\"") }
    if !n.ident.isEmpty { parts.append("id \"\(n.ident)\"") }
    if !n.classes.isEmpty { parts.append("classes [\(n.classes.joined(separator: " "))]") }
    parts.append("\(Int(frame.width))x\(Int(frame.height)) pt")
    return parts.joined(separator: ", ")
  }

  static func area(_ r: CGRect) -> CGFloat { r.width * r.height }
}

// MARK: - Change hash

enum ShareHash {
  static let width = 17
  static let height = 16

  /// 256-bit difference hash of a 17x16 grayscale image (row major): one bit per horizontal
  /// neighbour pair, set when the left pixel is brighter. 64 hex chars.
  static func dHash(gray g: [UInt8]) -> String {
    precondition(g.count == width * height)
    var bytes = [UInt8](repeating: 0, count: 32)
    for y in 0..<height {
      for x in 0..<(width - 1) where g[y * width + x] > g[y * width + x + 1] {
        let bit = y * (width - 1) + x
        bytes[bit / 8] |= 0x80 >> UInt8(bit % 8)
      }
    }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  /// The image as 17x16 grayscale: drawn at 8x that size, then each 8x8 block averaged (one big
  /// downscale aliases; this keeps a slide's text from flipping bits between two captures).
  static func gray(_ image: CGImage) -> [UInt8] {
    let k = 8
    let w = width * k, h = height * k
    var big = [UInt8](repeating: 0, count: w * h)
    big.withUnsafeMutableBytes { buf in
      guard let ctx = CGContext(
        data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
      else { return }
      ctx.interpolationQuality = .high
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    var out = [UInt8](repeating: 0, count: width * height)
    for by in 0..<height {
      for bx in 0..<width {
        var sum = 0
        for y in (by * k)..<((by + 1) * k) {
          for x in (bx * k)..<((bx + 1) * k) { sum += Int(big[y * w + x]) }
        }
        out[by * width + bx] = UInt8(sum / (k * k))
      }
    }
    return out
  }

  static func dHash(_ image: CGImage) -> String { dHash(gray: gray(image)) }

  /// Bits that differ between two hashes, or nil when they are not two hashes of the same size.
  static func distance(_ a: String, _ b: String) -> Int? {
    guard a.count == b.count else { return nil }
    var d = 0
    for (x, y) in zip(a, b) {
      guard let p = x.hexDigitValue, let q = y.hexDigitValue else { return nil }
      d += (p ^ q).nonzeroBitCount
    }
    return d
  }
}

// MARK: - Saving

enum ShareShot {
  static let maxWidth = 1920
  static let quality = 0.8

  /// The image at most `maxWidth` px wide (aspect kept).
  static func fitted(_ image: CGImage, maxWidth: Int = maxWidth) -> CGImage {
    guard image.width > maxWidth else { return image }
    let h = max(1, Int((Double(image.height) * Double(maxWidth) / Double(image.width)).rounded()))
    guard let ctx = CGContext(
      data: nil, width: maxWidth, height: h, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { return image }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: maxWidth, height: h))
    return ctx.makeImage() ?? image
  }

  static func jpeg(_ image: CGImage, quality: Double = quality) -> Data? {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(dest) ? data as Data : nil
  }

  /// The text on the image, one recognized line per line, in Vision's reading order.
  static func ocr(_ image: CGImage) -> String {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    do {
      try VNImageRequestHandler(cgImage: image, options: [:]).perform([req])
    } catch {
      return ""
    }
    return (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
  }

  /// Loads the text recognizer and its language model on one drawn word (a blank image would stop
  /// at detection).
  static func warmUp() {
    guard let ctx = CGContext(
      data: nil, width: 200, height: 60, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
    else { return }
    ctx.setFillColor(gray: 1, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: 200, height: 60))
    let word = NSAttributedString(string: "Relay", attributes: [
      .font: CTFontCreateWithName("Helvetica" as CFString, 36, nil), .foregroundColor: CGColor(gray: 0, alpha: 1),
    ])
    ctx.textPosition = CGPoint(x: 12, y: 16)
    CTLineDraw(CTLineCreateWithAttributedString(word), ctx)
    if let image = ctx.makeImage() { _ = ocr(image) }
  }
}

// MARK: - Capture

enum ShareCapture {
  /// The window to capture the region from: the app's window that holds the most of it (a popup
  /// over the call holds less), the smaller one on a tie.
  static func window(for region: ShareRegion, in windows: [(frame: CGRect, pid: pid_t)]) -> Int? {
    var best: (i: Int, overlap: CGFloat, area: CGFloat)?
    for (i, w) in windows.enumerated() where w.pid == region.pid {
      let o = w.frame.intersection(region.rect)
      guard !o.isNull, o.width > 0, o.height > 0 else { continue }
      let overlap = ShareParse.area(o), area = ShareParse.area(w.frame)
      if best == nil || overlap > best!.overlap || (overlap == best!.overlap && area < best!.area) {
        best = (i, overlap, area)
      }
    }
    return best?.i
  }

  /// The region in the window's own points (what `sourceRect` takes), clipped to the window.
  static func sourceRect(_ region: CGRect, window: CGRect) -> CGRect? {
    let local = region.offsetBy(dx: -window.minX, dy: -window.minY)
      .intersection(CGRect(origin: .zero, size: window.size))
    return local.isNull || local.width < 1 || local.height < 1 ? nil : local
  }

  /// Output pixels for a source rect at a backing scale, at most `ShareShot.maxWidth` wide.
  static func pixels(_ rect: CGRect, scale: CGFloat) -> (width: Int, height: Int) {
    var w = rect.width * scale, h = rect.height * scale
    let cap = CGFloat(ShareShot.maxWidth)
    if w > cap {
      h = h * cap / w
      w = cap
    }
    return (max(1, Int(w.rounded())), max(1, Int(h.rounded())))
  }

  /// Captures the region from the meeting app's window. Fails without Screen Recording (never asks).
  static func capture(_ region: ShareRegion, done: @escaping (Result<CGImage, ShareError>) -> Void) {
    guard CGPreflightScreenCaptureAccess() else {
      done(.failure(ShareError(reason: "no Screen Recording permission")))
      return
    }
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
      guard let content else {
        done(.failure(ShareError(reason: "shareable content: \(error?.localizedDescription ?? "none")")))
        return
      }
      let windows = content.windows.filter { $0.windowLayer == 0 }
      guard let i = window(for: region, in: windows.map { ($0.frame, $0.owningApplication?.processID ?? 0) }),
        let local = sourceRect(region.rect, window: windows[i].frame)
      else {
        done(.failure(ShareError(reason: "no window shows the shared content")))
        return
      }
      let filter = SCContentFilter(desktopIndependentWindow: windows[i])
      let config = SCStreamConfiguration()
      let px = pixels(local, scale: CGFloat(filter.pointPixelScale))
      config.sourceRect = local
      config.width = px.width
      config.height = px.height
      config.showsCursor = false
      SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
        if let image {
          done(.success(image))
        } else {
          done(.failure(ShareError(reason: "capture: \(error?.localizedDescription ?? "no image")")))
        }
      }
    }
  }
}

/// `--replay DIR` with DIR/share.mp4 and DIR/share.json (`{"from": s, "to": s}` on the replay
/// clock): sharing is on between the two, and a sample is the video's frame at the replay time,
/// so a proof runs without Screen Recording or a real call.
final class ShareReplay {
  let from: Double
  let to: Double
  private let generator: AVAssetImageGenerator

  init?(dir: URL) {
    let video = dir.appendingPathComponent("share.mp4")
    guard FileManager.default.fileExists(atPath: video.path),
      let data = try? Data(contentsOf: dir.appendingPathComponent("share.json")),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let from = (obj["from"] as? NSNumber)?.doubleValue, let to = (obj["to"] as? NSNumber)?.doubleValue
    else { return nil }
    self.from = from
    self.to = to
    generator = AVAssetImageGenerator(asset: AVURLAsset(url: video))
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
  }

  func frame(at seconds: Double, done: @escaping (Result<CGImage, ShareError>) -> Void) {
    generator.generateCGImageAsynchronously(for: CMTime(seconds: seconds, preferredTimescale: 600)) { image, _, error in
      if let image {
        done(.success(image))
      } else {
        done(.failure(ShareError(reason: "replay frame: \(error?.localizedDescription ?? "none")")))
      }
    }
  }
}

/// The `meeting.shot` ingest frame for one `shots.jsonl` line (kept verbatim under `shot`, as
/// `meeting.speakers` carries its lines) and its JPEG.
func shotFrame(line: String, jpeg: Data) -> String {
  "{\"t\":\"meeting.shot\",\"shot\":\(line),\"jpeg\":\"\(jpeg.base64EncodedString())\"}"
}

/// A `shots.jsonl` line's shot number.
func shotNumber(_ line: String) -> Int? {
  guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { return nil }
  return (obj["n"] as? NSNumber)?.intValue
}
