// Relay meeting capture spike: call detection from Core Audio's process list, call audio through a
// Core Audio process tap, the mic through AVAudioEngine, both as 16 kHz mono s16 tracks streamed
// to an ingest WebSocket in ~100 ms chunks and written to WAVs.
//
//   RelayMeetingCapture list                         audio processes and the meeting verdict
//   RelayMeetingCapture watch [--seconds N]          one JSON line per call start/end
//   RelayMeetingCapture record --seconds N --out DIR [--ws URL] [--vpio] [--bundle ID ...]
//
// No window titles, no Accessibility: a call is "a meeting app's process is running audio input".
import AVFoundation
import AppKit
import CoreAudio
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}

func fail(_ msg: String) -> Never {
  emit(["error": msg])
  exit(1)
}

// MARK: - Core Audio property helpers

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

// MARK: - Meeting detection

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

/// Meeting apps by bundle id prefix (helpers such as com.microsoft.teams2.helper match too).
let meetingApps: [(prefix: String, app: String)] = [
  ("com.microsoft.teams", "Microsoft Teams"),
  ("us.zoom.", "Zoom"),
  ("com.cisco.webexmeetingsapp", "Webex"),
  ("com.webex.", "Webex"),
  ("Cisco-Systems.Spark", "Webex"),
  ("com.tinyspeck.slackmacgap", "Slack"),
]

func meetingApp(_ bundle: String) -> String? {
  meetingApps.first { bundle.hasPrefix($0.prefix) }?.app
}

/// A call: some process of a meeting app is capturing the mic. Output alone (a notification sound,
/// a Slack clip) is not a call.
func activeCalls() -> [String: [AudioProcess]] {
  var calls: [String: [AudioProcess]] = [:]
  let procs = audioProcesses()
  for p in procs where p.input {
    guard let app = meetingApp(p.bundle) else { continue }
    calls[app, default: []] += procs.filter { meetingApp($0.bundle) == app }
  }
  return calls
}

// MARK: - Track: convert to 16 kHz mono s16, write WAV, hand chunks to the sink

let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

final class Track {
  let id: UInt8
  let name: String
  let file: AVAudioFile
  var converter: AVAudioConverter?
  var samples: Int64 = 0
  var firstHostTime: UInt64 = 0
  var sumSquares: Double = 0
  var peak: Int16 = 0
  var nonzero: Int64 = 0
  let sink: (UInt8, Int64, Data) -> Void
  let queue: DispatchQueue

  init(id: UInt8, name: String, url: URL, sink: @escaping (UInt8, Int64, Data) -> Void) throws {
    self.id = id
    self.name = name
    self.sink = sink
    self.queue = DispatchQueue(label: "track.\(name)")
    file = try AVAudioFile(
      forWriting: url, settings: target.settings, commonFormat: .pcmFormatInt16, interleaved: true)
  }

  /// Called off the realtime thread with a copy of the device buffer.
  func push(_ buf: AVAudioPCMBuffer, hostTime: UInt64) {
    if firstHostTime == 0 { firstHostTime = hostTime }
    if converter == nil || converter!.inputFormat != buf.format {
      converter = AVAudioConverter(from: buf.format, to: target)
      converter?.downmix = true
    }
    guard let conv = converter else { return }
    let cap = AVAudioFrameCount(Double(buf.frameLength) * 16_000 / buf.format.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return }
    var fed = false
    var err: NSError?
    conv.convert(to: out, error: &err) { _, status in
      if fed {
        status.pointee = .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buf
    }
    guard err == nil, out.frameLength > 0 else { return }
    try? file.write(from: out)
    let n = Int(out.frameLength)
    let p = out.int16ChannelData![0]
    for i in 0..<n {
      let s = p[i]
      if s != 0 { nonzero += 1 }
      if abs(Int32(s)) > abs(Int32(peak)) { peak = s }
      sumSquares += Double(s) * Double(s)
    }
    sink(id, samples, Data(bytes: p, count: n * 2))
    samples += Int64(n)
  }

  var stats: [String: Any] {
    let rms = samples > 0 ? (sumSquares / Double(samples)).squareRoot() / 32768 : 0
    return [
      "track": name, "seconds": Double(samples) / 16_000, "rms_dbfs": rms > 0 ? 20 * log10(rms) : -999,
      "peak": Int(peak), "nonzero_share": samples > 0 ? Double(nonzero) / Double(samples) : 0,
    ]
  }
}

// MARK: - Ingest WebSocket (binary frames: u8 track, i64 LE first sample index, s16 LE samples)

final class Ingest {
  let task: URLSessionWebSocketTask
  var sent = 0
  var bytes = 0
  var failed: String?
  let lock = NSLock()

  init(url: URL, hello: [String: Any]) {
    task = URLSession.shared.webSocketTask(with: url)
    task.resume()
    let data = try! JSONSerialization.data(withJSONObject: hello)
    task.send(.string(String(data: data, encoding: .utf8)!)) { _ in }
  }

  func send(track: UInt8, at: Int64, pcm: Data) {
    var frame = Data([track])
    withUnsafeBytes(of: at.littleEndian) { frame.append(contentsOf: $0) }
    frame.append(pcm)
    lock.lock()
    sent += 1
    bytes += frame.count
    lock.unlock()
    task.send(.data(frame)) { [weak self] e in
      if let e { self?.failed = e.localizedDescription }
    }
  }

  func close(_ summary: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: summary)
    let done = DispatchSemaphore(value: 0)
    task.send(.string(String(data: data, encoding: .utf8)!)) { _ in done.signal() }
    _ = done.wait(timeout: .now() + 3)
    task.cancel(with: .normalClosure, reason: nil)
  }
}

/// ~100 ms chunks per track before they go on the wire.
final class Chunker {
  var pending: [UInt8: (Int64, Data)] = [:]
  let out: (UInt8, Int64, Data) -> Void
  let lock = NSLock()
  init(out: @escaping (UInt8, Int64, Data) -> Void) { self.out = out }
  func add(_ track: UInt8, _ at: Int64, _ pcm: Data) {
    lock.lock()
    defer { lock.unlock() }
    let (start, prior) = pending[track] ?? (at, Data())
    var buf = prior
    buf.append(pcm)
    if buf.count >= 3_200 {
      out(track, start, buf)
      pending[track] = nil
    } else {
      pending[track] = (start, buf)
    }
  }
  func flush() {
    lock.lock()
    defer { lock.unlock() }
    for (t, (s, b)) in pending { out(t, s, b) }
    pending = [:]
  }
}

// MARK: - Process tap

final class SystemTap {
  var tapID = AudioObjectID(kAudioObjectUnknown)
  var aggID = AudioObjectID(kAudioObjectUnknown)
  var procID: AudioDeviceIOProcID?
  let track: Track

  init(track: Track, bundles: [String]) throws {
    self.track = track
    let ownPID = ProcessInfo.processInfo.processIdentifier
    let procs = audioProcesses()
    let desc: CATapDescription
    if bundles.isEmpty {
      // Everything the Mac plays except this helper.
      let own = procs.filter { $0.pid == ownPID }.map(\.object)
      desc = CATapDescription(stereoGlobalTapButExcludeProcesses: own)
    } else {
      let chosen = procs.filter { p in bundles.contains { p.bundle.hasPrefix($0) } }.map(\.object)
      guard !chosen.isEmpty else { throw NSError(domain: "tap", code: 1, userInfo: [NSLocalizedDescriptionKey: "no audio process for \(bundles)"]) }
      desc = CATapDescription(stereoMixdownOfProcesses: chosen)
    }
    desc.uuid = UUID()
    desc.name = "Relay meeting tap"
    desc.isPrivate = true
    desc.muteBehavior = .unmuted
    var err = AudioHardwareCreateProcessTap(desc, &tapID)
    guard err == noErr else { throw NSError(domain: "tap", code: Int(err), userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateProcessTap \(err)"]) }

    let outputID = prop(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(0)) ?? 0
    let outputUID = propString(outputID, kAudioDevicePropertyDeviceUID) ?? ""
    let agg: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Relay meeting tap",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey: outputUID,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
    ]
    err = AudioHardwareCreateAggregateDevice(agg as CFDictionary, &aggID)
    guard err == noErr else { throw NSError(domain: "tap", code: Int(err), userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateAggregateDevice \(err)"]) }

    var asbd = prop(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())!
    guard let fmt = AVAudioFormat(streamDescription: &asbd) else { throw NSError(domain: "tap", code: 2) }
    emit(["event": "tap", "format": "\(fmt)", "output": outputUID])
    let q = DispatchQueue(label: "tap.io", qos: .userInteractive)
    err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, q) { [track] _, inData, inTime, _, _ in
      let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
      guard let first = list.first, first.mDataByteSize > 0 else { return }
      let frames = AVAudioFrameCount(first.mDataByteSize / fmt.streamDescription.pointee.mBytesPerFrame)
      guard let copy = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { return }
      copy.frameLength = frames
      let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
      for (i, b) in list.enumerated() where i < dst.count {
        memcpy(dst[i].mData, b.mData, Int(b.mDataByteSize))
      }
      let host = inTime.pointee.mHostTime
      track.queue.async { track.push(copy, hostTime: host) }
    }
    guard err == noErr else { throw NSError(domain: "tap", code: Int(err)) }
    err = AudioDeviceStart(aggID, procID)
    guard err == noErr else { throw NSError(domain: "tap", code: Int(err), userInfo: [NSLocalizedDescriptionKey: "AudioDeviceStart \(err)"]) }
  }

  func stop() {
    AudioDeviceStop(aggID, procID)
    if let procID { AudioDeviceDestroyIOProcID(aggID, procID) }
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
  }
}

// MARK: - Commands

let args = Array(CommandLine.arguments.dropFirst())
func flag(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}
func flags(_ name: String) -> [String] {
  args.indices.filter { args[$0] == name && $0 + 1 < args.count }.map { args[$0 + 1] }
}
func frontmost() -> String { NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?" }

switch args.first {
case "list":
  for p in audioProcesses() where p.input || p.output || meetingApp(p.bundle) != nil {
    emit(["pid": Int(p.pid), "bundle": p.bundle, "input": p.input, "output": p.output, "meeting": meetingApp(p.bundle) ?? NSNull()])
  }
  emit(["calls": activeCalls().keys.sorted()])

case "watch":
  let until = Date().addingTimeInterval(Double(flag("--seconds") ?? "3600") ?? 3600)
  var live: Set<String> = []
  while Date() < until {
    let now = Set(activeCalls().keys)
    for app in now.subtracting(live) { emit(["event": "call.start", "app": app, "at": Date().timeIntervalSince1970]) }
    for app in live.subtracting(now) { emit(["event": "call.end", "app": app, "at": Date().timeIntervalSince1970]) }
    live = now
    Thread.sleep(forTimeInterval: 1)
  }

case "record":
  let seconds = Double(flag("--seconds") ?? "30") ?? 30
  let out = URL(fileURLWithPath: flag("--out") ?? FileManager.default.currentDirectoryPath)
  try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
  let front0 = frontmost()
  let ingest = flag("--ws").flatMap(URL.init(string:)).map {
    Ingest(url: $0, hello: ["t": "meeting.hello", "rate": 16_000, "format": "s16le", "tracks": ["app", "mic"]])
  }
  let chunker = Chunker { t, at, pcm in ingest?.send(track: t, at: at, pcm: pcm) }
  let sink: (UInt8, Int64, Data) -> Void = { t, at, pcm in chunker.add(t, at, pcm) }
  let app = try Track(id: 0, name: "app", url: out.appendingPathComponent("app.wav"), sink: sink)
  let mic = try Track(id: 1, name: "mic", url: out.appendingPathComponent("mic.wav"), sink: sink)

  let setupStarted = Date()
  // The mic prompt (first run only); AVAudioEngine alone delivers silence while it is undetermined.
  if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
    let asked = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { ok in
      emit(["event": "mic.permission", "granted": ok])
      asked.signal()
    }
    asked.wait()
  }
  let engine = AVAudioEngine()
  let input = engine.inputNode
  if args.contains("--vpio") {
    do {
      try input.setVoiceProcessingEnabled(true)
      // Do not duck the call for Isaac while we listen.
      input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
    } catch { emit(["warning": "vpio: \(error.localizedDescription)"]) }
  }
  let micFormat = input.outputFormat(forBus: 0)
  emit(["event": "mic", "format": "\(micFormat)", "vpio": input.isVoiceProcessingEnabled, "auth": AVCaptureDevice.authorizationStatus(for: .audio).rawValue])
  // VPIO hands back 3 deinterleaved channels; channel 0 is the processed voice.
  let micMono = AVAudioFormat(standardFormatWithSampleRate: micFormat.sampleRate, channels: 1)!
  input.installTap(onBus: 0, bufferSize: 1_024, format: micFormat) { buf, when in
    guard let copy = AVAudioPCMBuffer(pcmFormat: micMono, frameCapacity: buf.frameLength) else { return }
    copy.frameLength = buf.frameLength
    memcpy(copy.floatChannelData![0], buf.floatChannelData![0], Int(buf.frameLength) * 4)
    mic.queue.async { mic.push(copy, hostTime: when.hostTime) }
  }
  do { try engine.start() } catch { emit(["warning": "mic: \(error.localizedDescription)"]) }
  let tap: SystemTap
  do { tap = try SystemTap(track: app, bundles: flags("--bundle")) } catch { fail("tap: \(error.localizedDescription)") }
  let started = Date()
  emit(["event": "recording", "seconds": seconds, "frontmost": front0, "setup_s": started.timeIntervalSince(setupStarted)])

  RunLoop.main.run(until: started.addingTimeInterval(seconds))

  tap.stop()
  engine.stop()
  input.removeTap(onBus: 0)
  app.queue.sync {}
  mic.queue.sync {}
  chunker.flush()
  var tb = mach_timebase_info_data_t()
  mach_timebase_info(&tb)
  let micLeadMs = app.firstHostTime > 0 && mic.firstHostTime > 0
    ? (Double(Int64(app.firstHostTime) - Int64(mic.firstHostTime)) * Double(tb.numer) / Double(tb.denom)) / 1e6 : 0
  let summary: [String: Any] = [
    "t": "meeting.end", "wall_s": Date().timeIntervalSince(started), "tracks": [app.stats, mic.stats],
    "mic_starts_before_app_ms": micLeadMs, "frontmost_before": front0, "frontmost_after": frontmost(),
    "ws_frames": ingest?.sent ?? 0, "ws_bytes": ingest?.bytes ?? 0, "ws_error": ingest?.failed ?? NSNull(),
  ]
  ingest?.close(summary)
  emit(summary)

default:
  fail("usage: list | watch [--seconds N] | record --seconds N --out DIR [--ws URL] [--vpio] [--bundle ID]")
}
