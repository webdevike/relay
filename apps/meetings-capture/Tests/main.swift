// Logic tests for the capture helper: `sh build.sh test`.
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

print(failures == 0 ? "all passed" : "\(failures) failed")
exit(failures == 0 ? 0 : 1)
