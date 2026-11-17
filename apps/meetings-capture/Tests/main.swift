// Logic tests for the capture helper: `sh build.sh test`.
import AppKit
import AVFoundation
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String, line: Int = #line) {
  if !ok {
    failures += 1
    print("FAIL line \(line): \(what)")
  }
}

// Meeting apps by bundle id, helpers included; browsers flagged.
check(meetingApp("com.microsoft.teams2.helper")?.name == "Microsoft Teams", "teams helper")
check(meetingApp("us.zoom.xos")?.name == "Zoom", "zoom")
check(meetingApp("com.tinyspeck.slackmacgap.helper")?.name == "Slack", "slack helper")
check(meetingApp("com.google.Chrome.helper")?.browser == true, "chrome is a browser")
check(meetingApp("dev.eva.relay-desktop") == nil, "relay itself is never a meeting")
check(meetingApp("com.apple.Music") == nil, "music is not a meeting")

// The meeting's name from the window list: Teams' bigger main window is titled after its section.
let teamsWindows: [(title: String, area: Double)] = [
  ("Microsoft Teams", 480_000), ("", 115_200), ("Calendar", 1_683_072), ("Teams NRC", 1),
  ("UI/UX Standup | Microsoft Teams", 1_329_505),
]
check(meetingTitle(teamsWindows) == "UI/UX Standup", "teams meeting window \(String(describing: meetingTitle(teamsWindows)))")
check(meetingTitle([("Chat | Bob Lee | Microsoft Teams", 1_600_000), ("Calendar", 900_000)]) == nil, "teams chrome only")
check(meetingTitle([("Zoom Meeting", 1_000_000), ("Zoom Workplace", 800_000)]) == nil, "zoom chrome only")
check(meetingTitle([("Tiny", 50)]) == nil, "tiny windows skipped")

// Detection: 3 s of mic use starts a call, 15 s without ends it, a short blip is forgotten.
var d = CallDetector(startAfter: 3, endAfter: 15)
check(d.sample(["Zoom"], at: 0).isEmpty, "no start at once")
check(d.sample(["Zoom"], at: 2).isEmpty, "no start at 2 s")
check(d.sample(["Zoom"], at: 3) == [.start("Zoom")], "start at 3 s")
check(d.sample(["Zoom"], at: 4).isEmpty, "one start only")
check(d.sample([], at: 10).isEmpty, "quiet 6 s is not an end")
check(d.sample(["Zoom"], at: 11).isEmpty, "back on the mic")
check(d.sample([], at: 20).isEmpty, "quiet 9 s")
check(d.sample([], at: 26) == [.end("Zoom")], "end 15 s after the last use")
check(d.sample([], at: 27).isEmpty, "one end only")
var blip = CallDetector(startAfter: 3, endAfter: 15)
_ = blip.sample(["Slack"], at: 0)
_ = blip.sample(["Slack"], at: 1)
_ = blip.sample([], at: 3)
check(blip.sample(["Slack"], at: 4).isEmpty, "a blip does not count toward the next start")
check(blip.sample(["Slack"], at: 7) == [.start("Slack")], "a fresh 3 s starts it")
var two = CallDetector(startAfter: 3, endAfter: 15)
_ = two.sample(["Zoom", "Slack"], at: 0)
check(two.sample(["Zoom", "Slack"], at: 3) == [.start("Slack"), .start("Zoom")], "two apps, sorted")

// Uplink slices: from the ack, at most 1 s per frame, at most 10 s in flight.
check(nextSlice(sent: 0, acked: 0, written: 0) == nil, "nothing written")
check(nextSlice(sent: 0, acked: 0, written: 1_600)! == (0, 1_600), "a live 100 ms chunk")
check(nextSlice(sent: 0, acked: 0, written: 1_000_000)! == (0, 16_000), "catch-up frames are 1 s")
check(nextSlice(sent: 160_000, acked: 0, written: 1_000_000) == nil, "window full")
check(nextSlice(sent: 160_000, acked: 16_000, written: 1_000_000)! == (160_000, 16_000), "an ack opens the window")

// Frame layout: u8 track, i64 LE first sample, PCM.
let f = ingestFrame(track: 1, at: 258, pcm: Data([7, 8]))
check(f == Data([1, 2, 1, 0, 0, 0, 0, 0, 0, 7, 8]), "frame bytes \(Array(f))")

// Spool meta round trip.
let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("relay-meetings-test-\(UUID().uuidString)")
try! FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
let meta = SpoolMeta(id: "abc", app: "Zoom", title: "Standup", startedAt: 1_700_000_000_000, ended: true, endedAt: 1_700_000_060_000, micLeadMs: 12.5)
meta.write(tmp)
check(SpoolMeta.read(tmp) == meta, "meta round trip")

// A track appends to its file and counts samples; reopening continues at the end.
let t = try! Track(id: 0, name: "app", url: tmp.appendingPathComponent("app.pcm"))
var zeros = [Int16](repeating: 0, count: 16_000 * 61)
t.queue.sync { zeros.withUnsafeBufferPointer { t.append($0.baseAddress!, count: $0.count) } }
check(t.samples == 16_000 * 61, "samples counted")
check(t.silent(forLast: 60), "a minute of zeros is silent")
var one: [Int16] = [5]
t.queue.sync { one.withUnsafeBufferPointer { t.append($0.baseAddress!, count: 1) } }
t.close()
t.queue.sync { one.withUnsafeBufferPointer { t.append($0.baseAddress!, count: 1) } }
check(t.samples == 16_000 * 61 + 1, "nothing appended after close")
let again = try! Track(id: 0, name: "app", url: tmp.appendingPathComponent("app.pcm"))
check(again.samples == 16_000 * 61 + 1, "reopened track continues at the end")
again.close()
try? FileManager.default.removeItem(at: tmp)

// Speaker samples from the Teams call window (labels as Teams 26289 writes them).
func tileNode(_ title: String, talking: Bool? = nil) -> AXNode {
  var kids = [AXNode(classes: ["fui-Primitive", "bkg_x"]), AXNode(classes: ["fui-Primitive"]), AXNode(classes: ["fui-Primitive"])]
  if let talking { kids.append(AXNode(classes: talking ? ["fui-Flex", "vdi-frame-occlusion", "___1vvhwjq"] : ["fui-Flex", "___dv8x4j0"])) }
  return AXNode(role: "AXMenuItem", title: title, children: kids)
}
let david = SpeakerParse.tile(tileNode("David Taylor, Has control of production tools, Context menu is available", talking: true))
check(david == Tile(name: "David Taylor", muted: false, speaking: true), "talking tile \(String(describing: david))")
let ted = SpeakerParse.tile(tileNode("Ted Plaisted, video is on, Has control of production tools, muted, Context menu is available"))
check(ted == Tile(name: "Ted Plaisted", muted: true, speaking: false), "muted tile has no frame")
check(SpeakerParse.tile(tileNode("Ted Plaisted, Has control of production tools, Context menu is available", talking: false))?.speaking == false, "quiet frame")
check(SpeakerParse.tile(tileNode("Myself video, Isaac Weber, Has control of production tools, Unmuted, Has context menu")) == nil, "own tile skipped")
check(SpeakerParse.tile(AXNode(role: "AXMenuItem", title: "Ted Plaisted left the meeting")) == nil, "left notice is no tile")
check(SpeakerParse.tile(AXNode(role: "AXButton", title: "Chat")) == nil, "a button is no tile")
check(SpeakerParse.tile(AXNode(role: "AXGroup", desc: "Priya Shah, Speaking"))?.speaking == true, "a speaking label elsewhere (Meet, Zoom)")
let s = SpeakerParse.sample(tiles: [david!, ted!, david!], captions: [])
check(s.speaking == ["David Taylor"] && s.unmuted == ["David Taylor"] && s.roster == ["David Taylor", "Ted Plaisted"], "sample \(s)")

// Captions: a region named for captions, one item per line (speaker, words).
let region = AXNode(role: "AXGroup", title: "Live captions", children: [
  AXNode(role: "AXGroup", children: [AXNode(role: "AXStaticText", value: "Captions are turned on")]),
  AXNode(role: "AXGroup", children: [AXNode(role: "AXStaticText", value: "David Taylor"), AXNode(role: "AXStaticText", value: "So the settings govern how it is configured.")]),
  AXNode(role: "AXGroup", children: [AXNode(role: "AXGroup", children: [AXNode(role: "AXStaticText", value: "Ted Plaisted")]), AXNode(role: "AXStaticText", value: "Right.")]),
])
check(SpeakerParse.isCaptions(region), "captions region")
check(SpeakerParse.captions(region) == [Caption(name: "David Taylor", text: "So the settings govern how it is configured."), Caption(name: "Ted Plaisted", text: "Right.")], "caption lines \(SpeakerParse.captions(region))")
check(!SpeakerParse.isCaptions(AXNode(role: "AXButton", title: "Turn on live captions")), "the captions button is no region")

// The tap follows the device's real rate (AirPods in call mode: 24 kHz under a 48 kHz tap format).
let clock = TapClock(rate: 48_000)
check(clock.adopt(23_990) == 24_000 && clock.rate == 24_000, "half rate adopted")
check(clock.adopt(24_050) == nil, "small drift ignored")
check(clock.observe(sampleTime: 0, hostTime: 1_000) == nil, "first stamp opens the window")
let twoS = AVAudioTime.hostTime(forSeconds: 2)
check(clock.observe(sampleTime: 96_000, hostTime: 1_000 + twoS) == 48_000, "measured 48 kHz over 2 s")

let tmp2 = FileManager.default.temporaryDirectory.appendingPathComponent("relay-meetings-test2-\(UUID().uuidString)")
try! FileManager.default.createDirectory(at: tmp2, withIntermediateDirectories: true)

// Lines read from a growing JSONL, from any line on.
let jl = tmp2.appendingPathComponent("speakers.jsonl")
try! "{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n{\"a\":".write(to: jl, atomically: true, encoding: .utf8)
let lr = LineReader(url: jl)
check(lr.next(10) == ["{\"a\":1}", "{\"a\":2}", "{\"a\":3}"] && lr.line == 3, "whole lines only")
let fh = try! FileHandle(forWritingTo: jl)
_ = try! fh.seekToEnd()
fh.write("4}\n".data(using: .utf8)!)
try! fh.close()
check(lr.next(10) == ["{\"a\":4}"], "the finished line arrives")
lr.seek(1)
check(lr.next(1) == ["{\"a\":2}"] && lr.line == 2, "seek back")

// A delivery gap is filled with silence so the track stays on the wall clock.
let gt = try! Track(id: 1, name: "mic", url: tmp2.appendingPathComponent("mic.pcm"))
let fmt16 = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
let b = AVAudioPCMBuffer(pcmFormat: fmt16, frameCapacity: 1_600)!
b.frameLength = 1_600
for i in 0..<1_600 { b.floatChannelData![0][i] = 0.1 }
let h0: UInt64 = 1_000_000
gt.queue.sync { gt.push(b, hostTime: h0) }
let first = gt.samples
gt.queue.sync { gt.push(b, hostTime: h0 + AVAudioTime.hostTime(forSeconds: 0.1)) }
check(gt.samples - first == 1_600, "back-to-back buffers: no fill (\(gt.samples - first))")
let before = gt.samples
gt.queue.sync { gt.push(b, hostTime: h0 + AVAudioTime.hostTime(forSeconds: 1.2)) }
let added = gt.samples - before
check(abs(added - (16_000 + 1_600)) <= 40, "1 s away filled: \(added)")
let at = gt.sample(atHostTime: h0 + AVAudioTime.hostTime(forSeconds: 1.25))
check(abs(at - (before + 16_000 + 800)) <= 40, "host time maps onto the track: \(at) vs \(before + 16_800)")
gt.close()
try? FileManager.default.removeItem(at: tmp2)

// Screen share: the shared content is a big element whose words name a share, never a control.
check(ShareParse.matches(AXNode(role: "AXGroup", desc: "Screen sharing content from David Taylor")), "screen sharing label")
check(ShareParse.matches(AXNode(role: "AXGroup", classes: ["fui-Flex", "screen-share-video"])), "screen-share class")
check(ShareParse.matches(AXNode(role: "AXGroup", ident: "screenshare-stage")), "screenshare id")
check(ShareParse.matches(AXNode(role: "AXGroup", ident: "content-share-container")), "content-share id")
check(ShareParse.matches(AXNode(role: "AXImage", title: "David Taylor is presenting")), "is presenting")
check(ShareParse.matches(AXNode(role: "AXGroup", desc: "Shared content")), "shared content")
check(!ShareParse.matches(AXNode(role: "AXButton", title: "Share content")), "the share button")
check(!ShareParse.matches(AXNode(role: "AXButton", title: "Stop presenting")), "the stop button")
check(!ShareParse.matches(AXNode(role: "AXMenuItem", title: "David Taylor, is presenting, Context menu is available")), "a tile")
check(!ShareParse.matches(AXNode(role: "AXCheckBox", title: "Include computer sound when screen sharing")), "a checkbox")
check(!ShareParse.matches(AXNode(role: "AXRadioButton", title: "Shared content")), "a tab")
check(!ShareParse.matches(AXNode(role: "AXStaticText", desc: "David Taylor is presenting", value: "David Taylor is presenting")), "a text")
check(!ShareParse.matches(AXNode(role: "AXGroup", desc: "Share")), "share alone")
check(!ShareParse.matches(AXNode(role: "AXGroup", desc: "Presenter mode")), "presenter mode")
check(!ShareParse.matches(AXNode(role: "AXGroup", desc: "Gallery", classes: ["video-gallery"])), "the gallery")
check(!ShareParse.bigEnough(CGRect(x: 0, y: 0, width: 300, height: 40)), "a toolbar is too small")
check(ShareParse.bigEnough(CGRect(x: 0, y: 0, width: 320, height: 180)), "320x180 is enough")
let stage = CGRect(x: 0, y: 0, width: 1600, height: 900)
let content = CGRect(x: 160, y: 90, width: 1280, height: 720)
check(ShareParse.pick([stage, content, CGRect(x: 0, y: 0, width: 300, height: 40)]) == 1, "the content inside the stage")
check(ShareParse.pick([CGRect(x: 0, y: 0, width: 200, height: 100)]) == nil, "nothing big enough")
let said = ShareParse.describe(AXNode(role: "AXGroup", desc: "Shared content", classes: ["a", "b"]), frame: content)
check(said.contains("AXGroup") && said.contains("\"Shared content\"") && said.contains("[a b]") && said.contains("1280x720"), "matched line \(said)")

// Capture geometry: the app's window that holds the region, the region in its own points.
let shareRegion = ShareRegion(rect: CGRect(x: 300, y: 200, width: 1280, height: 720), pid: 42)
let shareWindows: [(frame: CGRect, pid: pid_t)] = [
  (CGRect(x: 0, y: 0, width: 3000, height: 2000), 7),
  (CGRect(x: 250, y: 150, width: 400, height: 300), 42),
  (CGRect(x: 100, y: 50, width: 1600, height: 1000), 42),
]
check(ShareCapture.window(for: shareRegion, in: shareWindows) == 2, "the call window, not a popup or another app")
check(ShareCapture.window(for: ShareRegion(rect: shareRegion.rect, pid: 9), in: shareWindows) == nil, "no window of the app")
check(ShareCapture.sourceRect(shareRegion.rect, window: shareWindows[2].frame) == CGRect(x: 200, y: 150, width: 1280, height: 720), "window-local rect")
check(ShareCapture.sourceRect(shareRegion.rect, window: CGRect(x: 100, y: 50, width: 800, height: 600)) == CGRect(x: 200, y: 150, width: 600, height: 450), "clipped to the window")
check(ShareCapture.sourceRect(shareRegion.rect, window: CGRect(x: 5000, y: 0, width: 100, height: 100)) == nil, "outside the window")
check(ShareCapture.pixels(CGRect(x: 0, y: 0, width: 1280, height: 720), scale: 2) == (1920, 1080), "capped at 1920 wide")
check(ShareCapture.pixels(CGRect(x: 0, y: 0, width: 640, height: 360), scale: 2) == (1280, 720), "backing scale")

// Change hash: the same slide hashes the same, a small change moves a few bits, a new slide many.
func slide(_ lines: [String], box: CGRect? = nil, width: Int = 1280, height: Int = 720) -> CGImage {
  let ctx = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  ctx.setFillColor(CGColor(red: 0.96, green: 0.96, blue: 0.94, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  for (i, l) in lines.enumerated() {
    let font = i == 0 ? NSFont.boldSystemFont(ofSize: 64) : NSFont.systemFont(ofSize: 40)
    (l as NSString).draw(at: NSPoint(x: 80, y: height - 140 - i * 90), withAttributes: [.font: font, .foregroundColor: NSColor.black])
  }
  NSGraphicsContext.current = nil
  if let box {
    ctx.setFillColor(CGColor(red: 0.8, green: 0.1, blue: 0.1, alpha: 1))
    ctx.fill(box)
  }
  return ctx.makeImage()!
}
let slideA = slide(["Quarterly revenue", "Sales grew in every region", "Hiring plan for next year", "Budget review on Friday"])
let slideB = slide(["Product roadmap", "Launch the mobile app", "Retire the old billing system"])
let hashA = ShareHash.dHash(slideA)
check(hashA.count == 64 && hashA.allSatisfy(\.isHexDigit), "64 hex chars")
check(ShareHash.dHash(slide(["Quarterly revenue", "Sales grew in every region", "Hiring plan for next year", "Budget review on Friday"])) == hashA, "same slide, same hash")
let smallMove = ShareHash.distance(hashA, ShareHash.dHash(slide(["Quarterly revenue", "Sales grew in every region", "Hiring plan for next year", "Budget review on Friday"], box: CGRect(x: 1150, y: 40, width: 40, height: 40))))!
let newSlide = ShareHash.distance(hashA, ShareHash.dHash(slideB))!
check(smallMove > 0 && smallMove <= 16, "a small box moves a few bits: \(smallMove)")
// Two text slides on one template differ less than a new layout would: 23 bits of 256 here, 30 to
// 38 between the replay fixture's slides, against 0 to 5 for the same slide with a moving box.
check(newSlide >= 20 && newSlide >= 3 * smallMove, "a new slide moves many: \(newSlide) vs \(smallMove)")
check(ShareHash.distance("ff", "0f") == 4 && ShareHash.distance("ab", "abc") == nil && ShareHash.distance("zz", "00") == nil, "hamming distance")
var ramp = [UInt8](repeating: 0, count: 17 * 16)
for y in 0..<16 { for x in 0..<17 { ramp[y * 17 + x] = UInt8(255 - x * 15) } }
check(ShareHash.dHash(gray: ramp) == String(repeating: "f", count: 64), "left brighter everywhere: every bit set")

// Saving: at most 1920 wide, a JPEG of that size, the text read back.
let wide = slide(["Wide"], width: 2560, height: 1440)
let fit = ShareShot.fitted(wide)
check(fit.width == 1920 && fit.height == 1080, "fitted \(fit.width)x\(fit.height)")
check(ShareShot.fitted(slideA).width == 1280, "small enough already")
let jpegData = ShareShot.jpeg(slideA)!
let jsrc = CGImageSourceCreateWithData(jpegData as CFData, nil)!
check(CGImageSourceGetType(jsrc) as String? == "public.jpeg" && CGImageSourceCreateImageAtIndex(jsrc, 0, nil)?.width == 1280, "jpeg round trip")
let read = ShareShot.ocr(slideA)
check(read.contains("Quarterly revenue") && read.contains("Budget review on Friday"), "ocr: \(read)")

// Upload: a `shots.jsonl` line goes verbatim under `shot`, with its JPEG in base64.
let shotLine = "{\"at\":16000,\"h\":720,\"hash\":\"00\",\"n\":3,\"ocr\":\"Hi\",\"t\":1700000000000,\"w\":1280}"
check(shotNumber(shotLine) == 3 && shotNumber("nope") == nil, "shot number")
let sf = try! JSONSerialization.jsonObject(with: Data(shotFrame(line: shotLine, jpeg: Data([1, 2, 3])).utf8)) as! [String: Any]
check(sf["t"] as? String == "meeting.shot" && (sf["shot"] as? [String: Any])?["n"] as? Int == 3 && (sf["shot"] as? [String: Any])?["t"] as? Int == 1_700_000_000_000 && sf["jpeg"] as? String == "AQID", "shot frame \(sf)")

print(failures == 0 ? "all passed" : "\(failures) failed")
exit(failures == 0 ? 0 : 1)
