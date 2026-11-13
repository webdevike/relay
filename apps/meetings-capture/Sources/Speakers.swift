// Who is talking, read from the meeting app's window through Accessibility, in the background:
// nothing is clicked, focused or typed, and the one attribute set is AXEnhancedUserInterface (below).
//
// Microsoft Teams (seen on 26289.203, 2026-11-05): every participant tile in the call window is an
// AXMenuItem titled "<Name>, [video is on, ]Has control of production tools, [muted, ]Context menu
// is available" (your own: "Myself video, <Name>, ..., Unmuted, Has context menu"). A remote
// tile that is unmuted has a frame child, and that child carries the `vdi-frame-occlusion` class
// while the person talks (gone while muted; checked against the call audio and mute changes).
// Captions, when on, are a region whose label or class names captions, with one item per line:
// the speaker's name, then the words. Other apps (Zoom, Meet in a browser) are read by the same
// rules: a "speaking"/"muted" item in a participant's label, and a captions region.
//
// A sample is taken five times a second; the full window is walked every few seconds to find the
// tiles and the captions region, and only those are read in between (a full walk of a Teams call
// window takes 30 to 500 ms).
//
// Chromium apps (Teams 2's web view, Slack, browsers) build their web content's accessibility tree
// only once an assistive app sets AXEnhancedUserInterface on them, as VoiceOver does. Until then a
// Teams call window is its native frame alone: on 2026-11-13 it read as 11 nodes with an empty
// "Web content" group and no AXWebArea, so no tile or caption was ever found; with the attribute set,
// 685 nodes under an AXWebArea. The watch sets it on every process of the app it reads (the call
// returns kAXErrorNotImplemented though Chromium acts on it) and puts back the ones it turned on.
import AppKit
import ApplicationServices
import Foundation

/// A read-only copy of part of an AX tree (parsed without touching the app again; tests build these).
struct AXNode: Equatable {
  var role = ""
  var subrole = ""
  var title = ""
  var desc = ""
  var value = ""
  var ident = ""
  var classes: [String] = []
  var children: [AXNode] = []

  var label: String { title.isEmpty ? desc : title }
  /// Static text in reading order.
  var texts: [String] {
    var out: [String] = []
    func walk(_ n: AXNode) {
      if n.role == "AXStaticText", !n.value.trimmingCharacters(in: .whitespaces).isEmpty {
        out.append(n.value.trimmingCharacters(in: .whitespaces))
      }
      n.children.forEach(walk)
    }
    walk(self)
    return out
  }
}

struct Caption: Equatable, Codable {
  var name: String
  var text: String
}

/// What the window showed at one moment.
struct SpeakerSample: Equatable {
  /// Remote participants the app marks as talking now (sorted).
  var speaking: [String] = []
  /// Remote participants not muted, when the app says who is muted (nil when it does not).
  var unmuted: [String]?
  /// Every remote participant on screen.
  var roster: [String] = []
  /// Caption lines on screen, oldest first.
  var captions: [Caption] = []

  var json: [String: Any] {
    var o: [String: Any] = ["speaking": speaking, "roster": roster]
    if let unmuted { o["unmuted"] = unmuted }
    if !captions.isEmpty { o["captions"] = captions.map { ["name": $0.name, "text": $0.text] } }
    return o
  }
}

/// One participant tile.
struct Tile: Equatable {
  var name: String
  var muted: Bool?
  var speaking: Bool
}

enum SpeakerParse {
  private static let selfMarks = ["myself video", "myself", "you", "(you)"]

  /// A participant tile from its node, or nil when the node is not one.
  static func tile(_ n: AXNode) -> Tile? {
    let label = n.label
    guard !label.isEmpty else { return nil }
    let tokens = label.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    guard tokens.count >= 2 else { return nil }
    let lower = tokens.map { $0.lowercased() }
    let isTeamsTile = n.role == "AXMenuItem" && lower.contains { $0.contains("context menu") }
    let marksSpeaking = lower.contains { $0 == "speaking" || $0 == "is speaking" || $0 == "talking" }
    guard isTeamsTile || marksSpeaking else { return nil }
    if selfMarks.contains(lower[0]) { return nil }
    let name = tokens[0]
    guard plausibleName(name) else { return nil }
    let muted: Bool? = lower.contains("muted") ? true : (lower.contains("unmuted") ? false : (isTeamsTile ? false : nil))
    let frame = n.children.contains { $0.classes.contains("vdi-frame-occlusion") }
    return Tile(name: name, muted: muted, speaking: marksSpeaking || frame)
  }

  /// A region of captions: its label, id or classes say captions (not a button that turns them on).
  static func isCaptions(_ n: AXNode) -> Bool {
    guard n.role == "AXGroup" || n.role == "AXList" || n.role == "AXScrollArea" else { return false }
    let hay = ([n.title, n.desc, n.ident] + n.classes).joined(separator: " ").lowercased()
    return (hay.contains("caption") || hay.contains("live transcript")) && !n.children.isEmpty
  }

  /// Caption lines of a captions region: each item's first text is the speaker, the rest the words.
  static func captions(_ region: AXNode) -> [Caption] {
    var out: [Caption] = []
    func item(_ n: AXNode) {
      let texts = n.texts
      if texts.count >= 2, plausibleName(texts[0]) {
        let words = texts.dropFirst().joined(separator: " ")
        if !words.isEmpty { out.append(Caption(name: texts[0], text: words)) }
        return
      }
      if texts.count >= 2 { n.children.forEach(item) }
    }
    region.children.forEach(item)
    return out
  }

  /// A person's display name: one to six words, no sentence punctuation, not a UI phrase.
  static func plausibleName(_ s: String) -> Bool {
    let words = s.split(separator: " ")
    guard (1...6).contains(words.count), s.count <= 80 else { return false }
    if s.contains(where: { ".!?:".contains($0) }) && !s.contains("(") { return false }
    let lower = s.lowercased()
    for ui in ["caption", "transcript", "turned on", "turned off", "settings", "language", "left the", "joined"] where lower.contains(ui) {
      return false
    }
    return true
  }

  /// The sample of a set of tiles and caption regions.
  static func sample(tiles: [Tile], captions: [Caption]) -> SpeakerSample {
    var seen = Set<String>()
    let unique = tiles.filter { seen.insert($0.name).inserted }
    let mutedKnown = unique.contains { $0.muted != nil }
    return SpeakerSample(
      speaking: unique.filter(\.speaking).map(\.name).sorted(),
      unmuted: mutedKnown ? unique.filter { $0.muted == false }.map(\.name).sorted() : nil,
      roster: unique.map(\.name).sorted(),
      captions: Array(captions.suffix(4)))
  }
}

// MARK: - Reading the live tree

private func axAttr(_ e: AXUIElement, _ a: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
}

private func axString(_ e: AXUIElement, _ a: String) -> String {
  axAttr(e, a) as? String ?? ""
}

private func axChildren(_ e: AXUIElement) -> [AXUIElement] {
  (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

private let enhancedUI = "AXEnhancedUserInterface"

/// A node with its children to `depth` (0: the node alone).
private func snapshot(_ e: AXUIElement, depth: Int, budget: inout Int) -> AXNode {
  budget -= 1
  var n = AXNode(
    role: axString(e, kAXRoleAttribute), subrole: axString(e, kAXSubroleAttribute),
    title: axString(e, kAXTitleAttribute), desc: axString(e, kAXDescriptionAttribute),
    value: axAttr(e, kAXValueAttribute) as? String ?? "", ident: axString(e, "AXDOMIdentifier"),
    classes: axAttr(e, "AXDOMClassList") as? [String] ?? [])
  if depth > 0 && budget > 0 {
    n.children = axChildren(e).map { snapshot($0, depth: depth - 1, budget: &budget) }
  }
  return n
}

/// What the walk needs to tell a tile or a captions region (fewer reads than a snapshot).
private func probe(_ e: AXUIElement) -> AXNode {
  var n = AXNode(role: axString(e, kAXRoleAttribute), title: axString(e, kAXTitleAttribute))
  if n.title.isEmpty { n.desc = axString(e, kAXDescriptionAttribute) }
  if n.role == "AXGroup" || n.role == "AXList" || n.role == "AXScrollArea" {
    n.ident = axString(e, "AXDOMIdentifier")
    n.classes = axAttr(e, "AXDOMClassList") as? [String] ?? []
    // isCaptions wants children; the walk only needs to know the label says captions.
    n.children = [AXNode()]
  }
  return n
}

/// A tile's label and its children's classes (where Teams marks the talker).
private func tileNode(_ e: AXUIElement) -> AXNode {
  var n = AXNode(role: axString(e, kAXRoleAttribute), title: axString(e, kAXTitleAttribute))
  if n.title.isEmpty { n.desc = axString(e, kAXDescriptionAttribute) }
  n.children = axChildren(e).map { AXNode(classes: axAttr($0, "AXDOMClassList") as? [String] ?? []) }
  return n
}

/// Samples the meeting app's windows on its own queue. `onSample` gets every changed sample and the
/// host time it was read at, plus the unchanged one every `keepAlive` seconds.
final class SpeakerWatch {
  private let app: MeetingApp
  private let onSample: (SpeakerSample, UInt64) -> Void
  private let queue = DispatchQueue(label: "speakers", qos: .utility)
  private var timer: DispatchSourceTimer?
  private var tiles: [AXUIElement] = []
  private var regions: [AXUIElement] = []
  private var lastWalk = Date.distantPast
  private var last: SpeakerSample?
  private var lastSent = Date.distantPast
  /// Processes this watch turned AXEnhancedUserInterface on for (only touched on `queue`).
  private var enhanced = Set<pid_t>()
  /// Processes already looked at, whether or not they needed it.
  private var checked = Set<pid_t>()
  static let period = 0.2
  static let walkEvery = 3.0
  static let keepAlive = 5.0

  init(app: MeetingApp, onSample: @escaping (SpeakerSample, UInt64) -> Void) {
    self.app = app
    self.onSample = onSample
  }

  /// False (and nothing runs) without the Accessibility grant; never prompts for it.
  @discardableResult
  func start() -> Bool {
    guard AXIsProcessTrusted() else { return false }
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + Self.period, repeating: Self.period, leeway: .milliseconds(20))
    t.setEventHandler { [weak self] in self?.tick() }
    timer = t
    t.resume()
    return true
  }

  func stop() {
    timer?.cancel()
    timer = nil
    queue.async { [self] in
      for pid in enhanced {
        AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), enhancedUI as CFString, kCFBooleanFalse)
      }
      enhanced = []
      checked = []
    }
  }

  private func appElements() -> [AXUIElement] {
    NSWorkspace.shared.runningApplications
      .filter { a in a.bundleIdentifier.map { b in app.prefixes.contains { b.hasPrefix($0) } } ?? false }
      .map { a -> AXUIElement in
        let e = AXUIElementCreateApplication(a.processIdentifier)
        AXUIElementSetMessagingTimeout(e, 0.25)
        enhance(e, a.processIdentifier)
        return e
      }
  }

  /// Turns the app's web content accessibility on (see the top of the file), once per process.
  private func enhance(_ e: AXUIElement, _ pid: pid_t) {
    guard checked.insert(pid).inserted, (axAttr(e, enhancedUI) as? Bool) != true else { return }
    AXUIElementSetAttributeValue(e, enhancedUI as CFString, kCFBooleanTrue)
    enhanced.insert(pid)
  }

  /// Finds the tiles and caption regions in every window of the app.
  private func walk() {
    tiles = []
    regions = []
    var budget = 6_000
    func visit(_ e: AXUIElement, _ depth: Int) {
      guard depth < 60, budget > 0 else { return }
      budget -= 1
      let n = probe(e)
      if SpeakerParse.tile(n) != nil {
        tiles.append(e)
        return
      }
      if SpeakerParse.isCaptions(n) {
        regions.append(e)
        return
      }
      for k in axChildren(e) { visit(k, depth + 1) }
    }
    for appEl in appElements() {
      for w in (axAttr(appEl, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { visit(w, 0) }
    }
    lastWalk = Date()
  }

  private func tick() {
    if Date().timeIntervalSince(lastWalk) >= Self.walkEvery { walk() }
    let host = mach_absolute_time()
    var found: [Tile] = []
    for e in tiles {
      let n = tileNode(e)
      if let t = SpeakerParse.tile(n) { found.append(t) } else { lastWalk = .distantPast }
    }
    var caps: [Caption] = []
    for e in regions {
      var b = 600
      caps += SpeakerParse.captions(snapshot(e, depth: 8, budget: &b))
    }
    if tiles.isEmpty && regions.isEmpty { return }
    let s = SpeakerParse.sample(tiles: found, captions: caps)
    if s != last || Date().timeIntervalSince(lastSent) >= Self.keepAlive {
      last = s
      lastSent = Date()
      onSample(s, host)
    }
  }
}
