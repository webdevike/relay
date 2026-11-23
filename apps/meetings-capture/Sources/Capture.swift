// Capture health: whether the call track really carries the other side of the call. Judged from
// both tracks' loudness (power per 500 ms) against the wall clock: every 30 s while
// recording (Recording.checkHealth: the last minutes, Isaac hears it once while the call runs) and
// over the whole recording when it stops (the verdict line in the notes header and the host log).
// It catches what otherwise only shows in the notes: the output device's own mic recorded as the
// call at double speed (a USB headset, 2026-11-23), a call track at the wrong rate (AirPods,
// 2026-11-05), a call track silent for minutes while Isaac talks, tap buffers of the wrong shape.
//
// Calibrated on the Mini's 32 stored recordings (2026-11-23): the headset-mic call f34ebd21 matches
// its mic at r 0.99 with 0.94 / 0.98 of their sound shared; no other recording passes r 0.40.
import AVFoundation
import Foundation

/// Loudness frames per second, and samples per frame (500 ms at 16 kHz).
let loudnessRate = 2.0
let loudnessFrame = sampleRate / 2

/// A track's loudness, one power (variance, full scale 1) per 500 ms frame, built as samples
/// arrive. Variance, not mean square: one mic here carries a DC offset of -42 dBFS.
struct Loudness {
  private(set) var frames: [Float] = []
  private var sum: Double = 0
  private var squares: Double = 0
  private var n = 0

  mutating func add(_ p: UnsafePointer<Int16>, count: Int) {
    for i in 0..<count {
      let x = Double(p[i]) / 32_768
      sum += x
      squares += x * x
      n += 1
      if n == loudnessFrame {
        let mean = sum / Double(n)
        frames.append(Float(max(0, squares / Double(n) - mean * mean)))
        sum = 0
        squares = 0
        n = 0
      }
    }
  }

  /// A spooled or stored track (`<dir>/<name>.pcm`, 16 kHz mono s16), read in 1 MB chunks.
  static func of(file: URL) -> [Float] {
    var l = Loudness()
    guard let h = try? FileHandle(forReadingFrom: file) else { return [] }
    defer { try? h.close() }
    while let data = try? h.read(upToCount: 1 << 20), !data.isEmpty {
      data.withUnsafeBytes { raw in
        let s = raw.bindMemory(to: Int16.self)
        if let base = s.baseAddress { l.add(base, count: s.count) }
      }
    }
    return l.frames
  }
}

/// What is wrong with the call track while the call runs.
enum CaptureIssue: Equatable {
  /// Its loudness follows the mic's (`speed`: call frames per mic frame): it is a mic, the output
  /// device's own.
  case micAsCall(r: Double, speed: Double)
  /// It holds `seconds` of audio for `wall` seconds of call.
  case drift(seconds: Double, wall: Double)
  /// No sound on it for `seconds` while the mic heard Isaac.
  case silentCall(seconds: Double)
}

/// The recording's verdict after it stops: `state` is good, missing (the other side), degraded or
/// unchecked (too short); `line` is the one line for the notes header and the host log.
struct CaptureVerdict: Codable, Equatable {
  var state: String
  var line: String
}

/// How the call track follows the mic at the lag (frames) where they match best: correlation of
/// their loudness in dB, the share of the mic's sound the call track also has, and of the call's
/// sound the mic also has.
struct CaptureMatch: Equatable {
  var r: Double
  var share: Double
  var back: Double
  var lag: Int
}

/// Above this a frame has sound in it: 10 dB over the track's floor (its 10th percentile), within
/// -70 to -45 dBFS. A fixed level fails both ways (a call where nobody talks sits at digital zero,
/// a far mic's speech peaks at -41 dBFS), and the cap keeps a track that never goes quiet (music,
/// a noisy room on the call) loud rather than silent.
struct Gate {
  let call: Float
  let mic: Float

  init(call: [Float], mic: [Float]) {
    self.call = Self.level(call)
    self.mic = Self.level(mic)
  }

  static func level(_ frames: [Float]) -> Float {
    guard !frames.isEmpty else { return -70 }
    let sorted = frames.sorted()
    return min(max(Capture.db(sorted[sorted.count / 10]) + 10, -70), -45)
  }
}

enum Capture {
  /// The call track's seconds per wall second outside this band is the wrong speed.
  static let speedBand = 0.9...1.1
  /// The call track is a mic when their loudness correlates this well AND each has sound where the
  /// other does. A call on speakers bleeds into the mic, but the call track stays quiet while
  /// Isaac talks, so the mic's share stays low.
  static let copyR = 0.8
  static let copyShare = 0.8
  /// The call track silent this long while the mic hears Isaac is the other side missing.
  static let silentSeconds = 180.0
  /// Live, the loudness match looks at this many seconds of the call track.
  static let matchSeconds = 120.0
  /// Nothing is judged on less wall time than this.
  static let minSeconds = 30.0
  /// Lags tried, in frames each way: the tap and the mic start a few seconds apart at most.
  static let maxLag = 10
  /// The match needs this many seconds of mic sound to say anything.
  static let minMicSound = 5.0

  static func db(_ meanSquare: Float) -> Float { 10 * log10(max(meanSquare, 1e-9)) }

  /// The mic's loudness under each call frame, the tracks' ends aligned (both end at the stop or
  /// at now): at `speed` call frames per mic frame, call frame j covers mic frames
  /// [m - (c - j) / speed, m - (c - j - 1) / speed). Nil where the mic has nothing there.
  static func micUnder(call c: Int, mic: [Float], speed: Double) -> [Float?] {
    let m = mic.count
    guard speed > 0 else { return Array(repeating: nil, count: c) }
    return (0..<c).map { j in
      let lo = Int((Double(m) - Double(c - j) / speed).rounded(.down))
      let hi = max(lo + 1, Int((Double(m) - Double(c - j - 1) / speed).rounded(.down)))
      guard lo >= 0, hi <= m else { return nil }
      var s: Float = 0
      for k in lo..<hi { s += mic[k] }
      return s / Float(hi - lo)
    }
  }

  /// How call frames `from...` follow `under` (micUnder) at the best lag; nil without enough mic
  /// sound to compare.
  static func match(call: [Float], under: [Float?], gate: Gate, from: Int = 0) -> CaptureMatch? {
    var best: CaptureMatch?
    for lag in -maxLag...maxLag {
      var xs: [Double] = []
      var ys: [Double] = []
      var micLoud = 0
      var callLoud = 0
      var both = 0
      for j in max(0, from)..<call.count {
        let k = j + lag
        guard k >= 0, k < under.count, let u = under[k] else { continue }
        let c = db(call[j])
        let m = db(u)
        let cl = c > gate.call
        let ml = m > gate.mic
        guard cl || ml else { continue }
        xs.append(Double(c))
        ys.append(Double(m))
        if ml { micLoud += 1 }
        if cl { callLoud += 1 }
        if cl && ml { both += 1 }
      }
      guard Double(micLoud) >= minMicSound * loudnessRate, callLoud > 0, let r = pearson(xs, ys) else { continue }
      if best == nil || r > best!.r {
        best = CaptureMatch(r: r, share: Double(both) / Double(micLoud), back: Double(both) / Double(callLoud), lag: lag)
      }
    }
    return best
  }

  static func pearson(_ x: [Double], _ y: [Double]) -> Double? {
    let n = Double(x.count)
    guard x.count >= 2 else { return nil }
    let mx = x.reduce(0, +) / n
    let my = y.reduce(0, +) / n
    var sxy = 0.0
    var sxx = 0.0
    var syy = 0.0
    for i in x.indices {
      sxy += (x[i] - mx) * (y[i] - my)
      sxx += (x[i] - mx) * (x[i] - mx)
      syy += (y[i] - my) * (y[i] - my)
    }
    guard sxx > 0, syy > 0 else { return nil }
    return sxy / (sxx * syy).squareRoot()
  }

  static func isCopy(_ m: CaptureMatch?) -> Bool {
    guard let m else { return false }
    return m.r >= copyR && m.share >= copyShare && m.back >= copyShare
  }

  /// Call frames per mic frame (1 when either has nothing yet).
  static func speed(call: [Float], mic: [Float]) -> Double {
    mic.isEmpty || call.isEmpty ? 1 : Double(call.count) / Double(mic.count)
  }

  /// Whether `call[range]` is silent while the mic under it heard Isaac: at most 1% of the call
  /// frames with sound, at least 10% of the mic's.
  static func silentWhileTalking(_ call: [Float], _ under: [Float?], _ gate: Gate, _ range: Range<Int>) -> Bool {
    guard !range.isEmpty else { return false }
    var callLoud = 0
    var micLoud = 0
    for j in range {
      if db(call[j]) > gate.call { callLoud += 1 }
      if let u = under[j], db(u) > gate.mic { micLoud += 1 }
    }
    return Double(callLoud) <= 0.01 * Double(range.count) && Double(micLoud) >= 0.1 * Double(range.count)
  }

  /// The live check: the call track against `wall` seconds since its first buffer and the mic's
  /// last minutes. Most specific first: a copy of the mic also runs at the wrong speed.
  static func live(call: [Float], mic: [Float], wall: Double) -> CaptureIssue? {
    guard wall >= minSeconds else { return nil }
    let sp = speed(call: call, mic: mic)
    let under = micUnder(call: call.count, mic: mic, speed: sp)
    let gate = Gate(call: call, mic: mic)
    let from = call.count - Int(matchSeconds * loudnessRate)
    if let m = match(call: call, under: under, gate: gate, from: from), isCopy(m) {
      return .micAsCall(r: m.r, speed: sp)
    }
    let seconds = Double(call.count) / loudnessRate
    if !speedBand.contains(seconds / wall) { return .drift(seconds: seconds, wall: wall) }
    let span = Int(silentSeconds * loudnessRate)
    if call.count >= span, silentWhileTalking(call, under, gate, (call.count - span)..<call.count) {
      return .silentCall(seconds: silentSeconds)
    }
    return nil
  }

  /// The whole recording's verdict, with the facts behind it, plus what the files cannot show
  /// (`problems` seen live: the mic dropping out, tap buffers of the wrong shape).
  static func verdict(call: [Float], mic: [Float], wall: Double, problems: [String] = []) -> (CaptureVerdict, [String: Any]) {
    let callS = Double(call.count) / loudnessRate
    let micS = Double(mic.count) / loudnessRate
    let sp = speed(call: call, mic: mic)
    let under = micUnder(call: call.count, mic: mic, speed: sp)
    let gate = Gate(call: call, mic: mic)
    let m = match(call: call, under: under, gate: gate)
    let callLoud = call.filter { db($0) > gate.call }.count
    let micLoud = mic.filter { db($0) > gate.mic }.count
    var facts: [String: Any] = [
      "callSeconds": callS, "micSeconds": micS, "wallSeconds": round1(wall),
      "callSoundSeconds": Double(callLoud) / loudnessRate, "micSoundSeconds": Double(micLoud) / loudnessRate,
      "gateDb": ["call": round1(Double(gate.call)), "mic": round1(Double(gate.mic))],
    ]
    if let m {
      facts["match"] = ["r": round2(m.r), "share": round2(m.share), "back": round2(m.back), "speed": round2(sp), "lag": m.lag]
    }
    let sizes = "call \(Int(callS)) s, mic \(Int(micS)) s, of \(Int(wall)) s"
    func done(_ v: CaptureVerdict) -> (CaptureVerdict, [String: Any]) {
      facts["state"] = v.state
      facts["line"] = v.line
      return (v, facts)
    }
    guard wall >= minSeconds else {
      return done(CaptureVerdict(state: "unchecked", line: "not checked: under \(Int(minSeconds)) s (\(sizes))"))
    }
    let micTalked = Double(micLoud) >= minMicSound * loudnessRate
    let callSilent = Double(callLoud) <= 0.01 * Double(max(call.count, 1))
    var missing: [String] = []
    if isCopy(m), let m {
      let at = abs(sp - 1) < 0.05 ? "" : String(format: " at %.1fx speed", 1 / sp)
      missing.append(String(format: "the call track is a mic (loudness r %.2f against yours%@)", m.r, at))
    } else if micTalked, callSilent {
      missing.append("no sound on the call track while your mic heard \(micLoud / Int(loudnessRate)) s")
    }
    var degraded = problems
    if missing.isEmpty, !micTalked, callSilent { degraded.append("almost no sound on either track") }
    if !speedBand.contains(callS / wall) {
      degraded.append("the call track holds \(Int(callS)) s for \(Int(wall)) s (wrong speed or dropped audio)")
    }
    if !speedBand.contains(micS / wall) { degraded.append("the mic track holds \(Int(micS)) s for \(Int(wall)) s") }
    let span = Int(silentSeconds * loudnessRate)
    if missing.isEmpty, call.count >= span {
      // 3 min windows, 10 s apart: the first one silent on the call while Isaac talks.
      for end in stride(from: span, through: call.count, by: Int(10 * loudnessRate))
      where silentWhileTalking(call, under, gate, (end - span)..<end) {
        degraded.append("the call track was silent for 3+ min from \(minutes(Int(Double(end - span) / loudnessRate))) while your mic heard you")
        break
      }
    }
    if !missing.isEmpty {
      return done(CaptureVerdict(state: "missing", line: "other side missing: \((missing + degraded).joined(separator: "; ")) (\(sizes))"))
    }
    if !degraded.isEmpty {
      return done(CaptureVerdict(state: "degraded", line: "degraded: \(degraded.joined(separator: "; ")) (\(sizes))"))
    }
    return done(CaptureVerdict(state: "good", line: "both sides captured (\(sizes))"))
  }

  /// `RelayMeetingCapture check DIR`: the verdict of a spool or a host recording folder (its
  /// `meta.json` gives the wall time, `startedAt` to `endedAt`), with the facts behind it and the
  /// loudness match at 1x for comparison.
  static func check(dir: URL) -> [String: Any] {
    let call = Loudness.of(file: dir.appendingPathComponent("app.pcm"))
    let mic = Loudness.of(file: dir.appendingPathComponent("mic.pcm"))
    let meta = (try? Data(contentsOf: dir.appendingPathComponent("meta.json")))
      .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
    let started = (meta["startedAt"] as? NSNumber)?.doubleValue ?? 0
    let ended = (meta["endedAt"] as? NSNumber)?.doubleValue ?? 0
    let wall = started > 0 && ended > started ? (ended - started) / 1000 : Double(max(call.count, mic.count)) / loudnessRate
    var (_, facts) = verdict(call: call, mic: mic, wall: wall)
    let flat = match(call: call, under: micUnder(call: call.count, mic: mic, speed: 1), gate: Gate(call: call, mic: mic))
    if let flat { facts["matchAt1x"] = ["r": round2(flat.r), "share": round2(flat.share), "back": round2(flat.back), "lag": flat.lag] }
    facts["id"] = meta["id"] ?? dir.lastPathComponent
    return facts
  }

  private static func round1(_ x: Double) -> Double { (x * 10).rounded() / 10 }
  private static func round2(_ x: Double) -> Double { (x * 100).rounded() / 100 }
  private static func minutes(_ s: Int) -> String { String(format: "%d:%02d", s / 60, s % 60) }
}

/// The shape of the tap's IO cycles since the last look (IO queue writes, the health check reads):
/// buffers that never carry the tap's channels leave the call track empty, and say why.
final class TapShape {
  private let lock = NSLock()
  private var cycles = 0
  private var rejected = 0
  private var seen = ""

  /// One IO cycle: `ok` when it could be read as `format`.
  func record(_ list: UnsafeMutableAudioBufferListPointer, format: AVAudioFormat, ok: Bool) {
    lock.lock()
    defer { lock.unlock() }
    cycles += 1
    if !ok {
      rejected += 1
      let want = tapBufferCount(format) == 1 ? "\(format.channelCount) ch" : "\(format.channelCount) x 1 ch"
      seen = "buffers of \(list.map { "\($0.mNumberChannels) ch" }.joined(separator: " + ")) where the tap gives \(want) at \(Int(format.sampleRate)) Hz"
    }
  }

  /// When most cycles since the last look could not be read, what they looked like.
  func take() -> String? {
    lock.lock()
    defer {
      cycles = 0
      rejected = 0
      lock.unlock()
    }
    guard cycles >= 10, rejected * 2 > cycles else { return nil }
    return seen
  }
}
