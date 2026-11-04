// Core Audio's process list, meeting-app matching and the call detector.
//
// A call is "a meeting app's process is running audio input": no window titles and no
// Accessibility needed. Browsers are reported too (Meet, Teams web), flagged `browser` so Relay
// asks before recording.
import AppKit
import CoreAudio
import Foundation

func prop<T: BitwiseCopyable>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ zero: T) -> T? {
  var addr = AudioObjectPropertyAddress(
    mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<T>.size)
  var value = zero
  let err = withUnsafeMutableBytes(of: &value) { AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, $0.baseAddress!) }
  return err == noErr ? value : nil
}

func propArray(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> [AudioObjectID] {
  var addr = AudioObjectPropertyAddress(
    mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(obj, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

func propString(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
  var addr = AudioObjectPropertyAddress(
    mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<CFString?>.size)
  var value: Unmanaged<CFString>?
  guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr, let v = value else {
    return nil
  }
  return v.takeRetainedValue() as String
}

struct AudioProcess {
  let object: AudioObjectID
  let pid: pid_t
  let bundle: String
  let input: Bool
  let output: Bool
}

func audioProcesses() -> [AudioProcess] {
  propArray(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).map { o in
    AudioProcess(
      object: o,
      pid: prop(o, kAudioProcessPropertyPID, pid_t(0)) ?? 0,
      bundle: propString(o, kAudioProcessPropertyBundleID) ?? "",
      input: (prop(o, kAudioProcessPropertyIsRunningInput, UInt32(0)) ?? 0) != 0,
      output: (prop(o, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0) != 0)
  }
}

struct MeetingApp: Equatable {
  let name: String
  /// Bundle id prefixes of every process of the app (helpers such as com.microsoft.teams2.helper match).
  let prefixes: [String]
  let browser: Bool
}

let meetingApps: [MeetingApp] = [
  MeetingApp(name: "Microsoft Teams", prefixes: ["com.microsoft.teams"], browser: false),
  MeetingApp(name: "Zoom", prefixes: ["us.zoom."], browser: false),
  MeetingApp(name: "Webex", prefixes: ["com.cisco.webexmeetingsapp", "com.webex.", "Cisco-Systems.Spark"], browser: false),
  MeetingApp(name: "Slack", prefixes: ["com.tinyspeck.slackmacgap"], browser: false),
  MeetingApp(name: "Google Chrome", prefixes: ["com.google.Chrome"], browser: true),
  MeetingApp(name: "Arc", prefixes: ["company.thebrowser."], browser: true),
  MeetingApp(name: "Safari", prefixes: ["com.apple.Safari", "com.apple.WebKit."], browser: true),
  MeetingApp(name: "Microsoft Edge", prefixes: ["com.microsoft.edgemac"], browser: true),
  MeetingApp(name: "Firefox", prefixes: ["org.mozilla.firefox"], browser: true),
]

func meetingApp(_ bundle: String) -> MeetingApp? {
  meetingApps.first { app in app.prefixes.contains { bundle.hasPrefix($0) } }
}

func meetingApp(named name: String) -> MeetingApp? {
  meetingApps.first { $0.name == name }
}

/// Meeting apps with some process capturing the mic right now. Output alone (a notification sound,
/// a Slack clip playing) is not a call.
func appsUsingMic(_ procs: [AudioProcess]) -> Set<String> {
  Set(procs.filter(\.input).compactMap { meetingApp($0.bundle)?.name })
}

/// Every audio process of `app` (the tap mixes all of them, so Teams' helpers are included).
func processes(of app: MeetingApp, in procs: [AudioProcess]) -> [AudioProcess] {
  procs.filter { p in app.prefixes.contains { p.bundle.hasPrefix($0) } }
}

/// Debounces the raw "which apps use the mic" samples into call starts and ends: a call starts
/// once an app has used the mic for `startAfter` seconds and ends once it has not for `endAfter`.
struct CallDetector {
  let startAfter: TimeInterval
  let endAfter: TimeInterval
  private var firstSeen: [String: TimeInterval] = [:]
  private var lastSeen: [String: TimeInterval] = [:]
  private(set) var live: Set<String> = []

  init(startAfter: TimeInterval = 3, endAfter: TimeInterval = 15) {
    self.startAfter = startAfter
    self.endAfter = endAfter
  }

  enum Event: Equatable {
    case start(String)
    case end(String)
  }

  mutating func sample(_ using: Set<String>, at now: TimeInterval) -> [Event] {
    var events: [Event] = []
    for app in using {
      if firstSeen[app] == nil { firstSeen[app] = now }
      lastSeen[app] = now
    }
    for (app, first) in firstSeen where !using.contains(app) && !live.contains(app) {
      // A blip shorter than the start debounce (a voice clip, a device test) is forgotten.
      if now - (lastSeen[app] ?? first) > 1.5 { firstSeen[app] = nil }
    }
    for app in using.sorted() where !live.contains(app) {
      if let first = firstSeen[app], now - first >= startAfter {
        live.insert(app)
        events.append(.start(app))
      }
    }
    for app in live.sorted() where !using.contains(app) {
      if let last = lastSeen[app], now - last >= endAfter {
        live.remove(app)
        firstSeen[app] = nil
        lastSeen[app] = nil
        events.append(.end(app))
      }
    }
    return events
  }

  /// Forgets `app` (a recording stopped by hand): it starts again only after the mic goes quiet.
  mutating func forget(_ app: String) {
    live.remove(app)
  }
}

/// The largest titled window of the app, through the window list (titles need Screen Recording,
/// which Relay holds for Assist; without it the title is nil and the calendar names the meeting).
func windowTitle(of app: MeetingApp) -> String? {
  let pids = Set(NSWorkspace.shared.runningApplications.compactMap { a -> pid_t? in
    guard let b = a.bundleIdentifier, app.prefixes.contains(where: { b.hasPrefix($0) }) else { return nil }
    return a.processIdentifier
  })
  guard !pids.isEmpty,
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return nil }
  var best: (area: Double, title: String)?
  for w in info {
    guard let pid = w[kCGWindowOwnerPID as String] as? pid_t, pids.contains(pid),
      let name = w[kCGWindowName as String] as? String, !name.trimmingCharacters(in: .whitespaces).isEmpty,
      let bounds = w[kCGWindowBounds as String] as? [String: Double]
    else { continue }
    let area = (bounds["Width"] ?? 0) * (bounds["Height"] ?? 0)
    if best == nil || area > best!.area { best = (area, name) }
  }
  return best?.title
}
