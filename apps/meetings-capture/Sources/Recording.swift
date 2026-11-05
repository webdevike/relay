// One recording: the app track (process tap, scoped to the meeting app) and the mic track
// (AVAudioEngine, no voice processing: VPIO silences a tap in the same process), both into the
// spool. `--replay DIR` feeds DIR/app.wav and DIR/mic.wav in real time instead, for tests that must
// not touch the Mac's audio or its privacy prompts.
import AVFoundation
import CoreAudio
import Foundation

enum Health: String {
  case ok
  /// The app track has been digital silence for a minute while the app plays audio: the System
  /// Audio Recording grant is missing or the tap broke.
  case silentApp = "silent-app"
  /// The mic track stopped growing (no grant, device gone).
  case noMic = "no-mic"
}

final class Recording {
  let dir: URL
  private(set) var meta: SpoolMeta
  let app: Track
  let mic: Track
  private let meetingApp: MeetingApp?
  private var tap: ProcessTap?
  private var engine: AVAudioEngine?
  private var engineObserver: NSObjectProtocol?
  private var replayTimer: DispatchSourceTimer?
  private let micQueue = DispatchQueue(label: "mic.setup")
  private var lastMicSamples: Int64 = 0
  private var micStalledSince: Date?
  private(set) var health: Health = .ok
  private(set) var warnings: [String] = []
  /// Watchdog state (main queue): when each track last grew, when it was last restarted.
  private var watchTimer: DispatchSourceTimer?
  private var grew: [Int64] = [0, 0]
  private var grewAt: [Date] = [Date(), Date()]
  private var restartedAt: [Date] = [.distantPast, .distantPast]
  private var deviceListeners: [(AudioObjectPropertySelector, AudioObjectPropertyListenerBlock)] = []
  /// Who is talking, from the meeting app's window (`speakers.jsonl`, one sample per line).
  private var speakerWatch: SpeakerWatch?
  private let speakerQueue = DispatchQueue(label: "speakers.spool")
  private var speakerHandle: FileHandle?
  private let speakerLock = NSLock()
  private var _speakerLines = 0

  init(dir: URL, meta: SpoolMeta, app: MeetingApp?, replay: URL?) throws {
    self.dir = dir
    self.meta = meta
    meetingApp = app
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    meta.write(dir)
    self.app = try Track(id: 0, name: "app", url: dir.appendingPathComponent("app.pcm"))
    mic = try Track(id: 1, name: "mic", url: dir.appendingPathComponent("mic.pcm"))
    if let replay {
      try startReplay(replay)
    } else {
      startMic()
      startTap()
      startWatch()
      startSpeakers()
    }
  }

  /// Leftover spool from an earlier run (host away, helper restarted): read-only, already ended.
  init(leftover dir: URL, meta: SpoolMeta) throws {
    self.dir = dir
    self.meta = meta
    meetingApp = nil
    app = try Track(id: 0, name: "app", url: dir.appendingPathComponent("app.pcm"))
    mic = try Track(id: 1, name: "mic", url: dir.appendingPathComponent("mic.pcm"))
    _speakerLines = Self.lineCount(speakersURL)
  }

  var files: [URL] { [app.url, mic.url] }
  func written(_ i: Int) -> Int64 { i == 0 ? app.samples : mic.samples }
  var speakersURL: URL { dir.appendingPathComponent("speakers.jsonl") }
  /// Speaker samples written to `speakers.jsonl` so far.
  var speakerLines: Int {
    speakerLock.lock()
    defer { speakerLock.unlock() }
    return _speakerLines
  }

  static func lineCount(_ url: URL) -> Int {
    guard let data = try? Data(contentsOf: url) else { return 0 }
    return data.reduce(0) { $0 + ($1 == 0x0A ? 1 : 0) }
  }

  // MARK: Speakers

  private func startSpeakers() {
    guard let meetingApp else { return }
    let watch = SpeakerWatch(app: meetingApp) { [weak self] sample, host in self?.speakerSample(sample, host) }
    if watch.start() {
      speakerWatch = watch
    } else {
      warnings.append("speakers: Relay has no Accessibility grant, so remote speakers are told apart by voice only")
    }
  }

  /// One sample from the window, stamped with where its moment falls on the app track.
  private func speakerSample(_ s: SpeakerSample, _ host: UInt64) {
    var obj = s.json
    obj["at"] = app.sample(atHostTime: host)
    obj["t"] = nowMs()
    writeSpeakerLine(obj)
  }

  /// Appends one sample to `speakers.jsonl` (any thread).
  private func writeSpeakerLine(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    speakerQueue.async { [self] in
      if speakerHandle == nil {
        if !FileManager.default.fileExists(atPath: speakersURL.path) {
          FileManager.default.createFile(atPath: speakersURL.path, contents: nil)
        }
        speakerHandle = try? FileHandle(forWritingTo: speakersURL)
        _ = try? speakerHandle?.seekToEnd()
      }
      guard let h = speakerHandle else { return }
      h.write(data + Data([0x0A]))
      speakerLock.lock()
      _speakerLines += 1
      speakerLock.unlock()
    }
  }

  // MARK: Watchdog

  /// Once a second: a track that stopped growing for 2 s is restarted (the mic engine stops for good
  /// when the input device changes, e.g. AirPods connecting mid-call: 2026-11-05's no-mic), and a
  /// default device change restarts the matching side at once.
  private func startWatch() {
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + 1, repeating: 1)
    t.setEventHandler { [weak self] in self?.watch() }
    watchTimer = t
    t.resume()
    for (sel, side) in [(kAudioHardwarePropertyDefaultInputDevice, 1), (kAudioHardwarePropertyDefaultOutputDevice, 0)] {
      var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
      let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
        self?.restart(side, because: side == 1 ? "the default input changed" : "the default output changed")
      }
      if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, .main, block) == noErr {
        deviceListeners.append((sel, block))
      }
    }
  }

  private func watch() {
    guard !meta.ended else { return }
    let now = Date()
    for (i, track) in [app, mic].enumerated() {
      let n = track.samples
      if n != grew[i] {
        grew[i] = n
        grewAt[i] = now
      } else if now.timeIntervalSince(grewAt[i]) >= 2 {
        restart(i, because: "no audio for 2 s")
      }
    }
  }

  /// Restarts the tap (0) or the mic (1); at most once every 3 s per side.
  private func restart(_ side: Int, because why: String) {
    guard !meta.ended, replayTimer == nil, Date().timeIntervalSince(restartedAt[side]) >= 3 else { return }
    restartedAt[side] = Date()
    if side == 0 {
      tap?.stop()
      tap = nil
      startTap()
      warn("call audio: \(why); tap rebuilt")
    } else {
      stopMic()
      startMic()
      warn("mic: \(why); listening on \(defaultInputName() ?? "the default input")")
    }
  }

  private func stopMic() {
    if let o = engineObserver { NotificationCenter.default.removeObserver(o) }
    engineObserver = nil
    if let engine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    engine = nil
  }

  /// A warning for Relay's log, unless it repeats the last one (a missing device retries often).
  private func warn(_ w: String) {
    if warnings.last != w { warnings.append(w) }
  }

  private func defaultInputName() -> String? {
    let id = prop(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice, AudioObjectID(0)) ?? 0
    return id == 0 ? nil : propString(id, kAudioObjectPropertyName)
  }

  private func startTap() {
    let procs = meetingApp.map { processes(of: $0, in: audioProcesses()) } ?? []
    do {
      tap = try ProcessTap(track: app, processes: procs) { note in
        DispatchQueue.main.async { [weak self] in self?.warnings.append(note) }
      }
      if procs.isEmpty {
        meta.globalTap = true
        meta.write(dir)
        warnings.append("no audio process for \(meetingApp?.name ?? "the app"); recording everything the Mac plays")
      }
    } catch {
      warn("tap: \(error)")
    }
  }

  /// Rebuilds the tap when the app started playing from a process it does not cover (Teams moves
  /// call audio to a new helper on some joins).
  func refreshTap() {
    guard let meetingApp, engine != nil || tap != nil, !meta.ended else { return }
    let playing = processes(of: meetingApp, in: audioProcesses()).filter(\.output)
    guard !playing.isEmpty else { return }
    let covered = tap?.scope ?? []
    if !covered.isEmpty, playing.allSatisfy({ covered.contains($0.object) }) { return }
    tap?.stop()
    tap = nil
    startTap()
  }

  private func startMic() {
    // inputNode blocks while a privacy prompt is up, so the mic is set up off the main thread.
    micQueue.async { [self] in
      let begin = { [self] in
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
          DispatchQueue.main.async { self.warn("mic: no input device") }
          return
        }
        let mono = AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: 1)!
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [mic] buf, when in
          guard let copy = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buf.frameLength), let src = buf.floatChannelData else { return }
          copy.frameLength = buf.frameLength
          memcpy(copy.floatChannelData![0], src[0], Int(buf.frameLength) * 4)
          mic.queue.async { mic.push(copy, hostTime: when.hostTime) }
        }
        do {
          try engine.start()
          DispatchQueue.main.async {
            guard !self.meta.ended else {
              engine.stop()
              return
            }
            self.engine = engine
            // A new default input, a format change or the device going away stops the engine for
            // good and posts this; it is listened again on whatever is the input now.
            self.engineObserver = NotificationCenter.default.addObserver(
              forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self] _ in self?.restart(1, because: "the input device changed") }
          }
        } catch {
          DispatchQueue.main.async { self.warn("mic: \(error.localizedDescription)") }
        }
      }
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .authorized:
        begin()
      case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio) { ok in
          if ok { self.micQueue.async(execute: begin) }
        }
      default:
        DispatchQueue.main.async { self.warn("mic: permission denied") }
      }
    }
  }

  /// DIR/app.wav and DIR/mic.wav (16 kHz mono s16) fed at real time, paced by the wall clock so a
  /// late timer tick catches up instead of slowing the recording down. DIR/speakers.jsonl, when
  /// there, is the window's samples (`at` on app.wav), written to the spool as their time comes.
  private func startReplay(_ src: URL) throws {
    let sources = try ["app", "mic"].map { name -> AVAudioFile in
      let f = try AVAudioFile(forReading: src.appendingPathComponent("\(name).wav"), commonFormat: .pcmFormatInt16, interleaved: true)
      guard f.processingFormat.sampleRate == Double(sampleRate), f.processingFormat.channelCount == 1 else {
        throw TapError(description: "replay \(name).wav must be 16 kHz mono")
      }
      return f
    }
    let tracks = [app, mic]
    var cues: [(at: Int64, line: [String: Any])] = []
    if let text = try? String(contentsOf: src.appendingPathComponent("speakers.jsonl"), encoding: .utf8) {
      for l in text.split(separator: "\n") {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any],
          let at = (obj["at"] as? NSNumber)?.int64Value
        else { continue }
        cues.append((at, obj))
      }
      cues.sort { $0.at < $1.at }
    }
    let begin = Date()
    var fed: Int64 = 0
    let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "replay"))
    t.schedule(deadline: .now(), repeating: 0.1)
    t.setEventHandler {
      let due = Int64(Date().timeIntervalSince(begin) * Double(sampleRate))
      let n = Int(due - fed)
      guard n > 0 else { return }
      fed = due
      for (file, track) in zip(sources, tracks) {
        var samples = [Int16](repeating: 0, count: n)
        // Past the end of a file the track keeps going with silence, as a live track would.
        if let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(n)),
          (try? file.read(into: buf, frameCount: AVAudioFrameCount(n))) != nil, buf.frameLength > 0
        {
          for i in 0..<Int(buf.frameLength) { samples[i] = buf.int16ChannelData![0][i] }
        }
        track.queue.async { samples.withUnsafeBufferPointer { track.append($0.baseAddress!, count: n) } }
      }
      while let c = cues.first, c.at <= fed {
        cues.removeFirst()
        var line = c.line
        line["t"] = nowMs()
        self.writeSpeakerLine(line)
      }
    }
    replayTimer = t
    t.resume()
  }

  /// Re-evaluated every few seconds while recording; true when it changed.
  func checkHealth(now: Date = Date()) -> Bool {
    let before = health
    let m = mic.samples
    if m == lastMicSamples {
      if micStalledSince == nil { micStalledSince = now }
    } else {
      micStalledSince = nil
      lastMicSamples = m
    }
    let appPlaying = replayTimer != nil || meetingApp.map { processes(of: $0, in: audioProcesses()).contains(where: \.output) } ?? false
    if appPlaying && app.silent(forLast: 60) {
      health = .silentApp
    } else if let since = micStalledSince, now.timeIntervalSince(since) >= 10 {
      health = .noMic
    } else {
      health = .ok
    }
    return health != before
  }

  /// Stops capture, closes the files and marks the spool ended.
  func stop() {
    guard !meta.ended else { return }
    replayTimer?.cancel()
    replayTimer = nil
    tap?.stop()
    tap = nil
    watchTimer?.cancel()
    watchTimer = nil
    for (sel, block) in deviceListeners {
      var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
      AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, .main, block)
    }
    deviceListeners = []
    speakerWatch?.stop()
    speakerWatch = nil
    stopMic()
    speakerQueue.sync {
      try? speakerHandle?.close()
      speakerHandle = nil
    }
    app.close()
    mic.close()
    var tb = mach_timebase_info_data_t()
    mach_timebase_info(&tb)
    if app.firstHostTime > 0 && mic.firstHostTime > 0 {
      let ns = Double(Int64(app.firstHostTime) - Int64(mic.firstHostTime)) * Double(tb.numer) / Double(tb.denom)
      meta.micLeadMs = (ns / 1e6 * 10).rounded() / 10
    }
    meta.ended = true
    meta.endedAt = (Date().timeIntervalSince1970 * 1000).rounded()
    meta.write(dir)
  }

  var seconds: Double { Double(max(app.samples, mic.samples)) / Double(sampleRate) }
}
