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
  private var replayTimer: DispatchSourceTimer?
  private let micQueue = DispatchQueue(label: "mic.setup")
  private var lastMicSamples: Int64 = 0
  private var micStalledSince: Date?
  private(set) var health: Health = .ok
  private(set) var warnings: [String] = []

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
    }
  }

  /// Leftover spool from an earlier run (host away, helper restarted): read-only, already ended.
  init(leftover dir: URL, meta: SpoolMeta) throws {
    self.dir = dir
    self.meta = meta
    meetingApp = nil
    app = try Track(id: 0, name: "app", url: dir.appendingPathComponent("app.pcm"))
    mic = try Track(id: 1, name: "mic", url: dir.appendingPathComponent("mic.pcm"))
  }

  var files: [URL] { [app.url, mic.url] }
  func written(_ i: Int) -> Int64 { i == 0 ? app.samples : mic.samples }

  private func startTap() {
    let procs = meetingApp.map { processes(of: $0, in: audioProcesses()) } ?? []
    do {
      tap = try ProcessTap(track: app, processes: procs)
      if procs.isEmpty {
        meta.globalTap = true
        meta.write(dir)
        warnings.append("no audio process for \(meetingApp?.name ?? "the app"); recording everything the Mac plays")
      }
    } catch {
      warnings.append("tap: \(error)")
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
          DispatchQueue.main.async { self.warnings.append("mic: no input device") }
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
          DispatchQueue.main.async { self.engine = engine }
        } catch {
          DispatchQueue.main.async { self.warnings.append("mic: \(error.localizedDescription)") }
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
        DispatchQueue.main.async { self.warnings.append("mic: permission denied") }
      }
    }
  }

  private func startReplay(_ src: URL) throws {
    let sources = try ["app", "mic"].map { try AVAudioFile(forReading: src.appendingPathComponent("\($0).wav")) }
    let tracks = [app, mic]
    let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "replay"))
    t.schedule(deadline: .now(), repeating: 0.1)
    t.setEventHandler {
      for (file, track) in zip(sources, tracks) {
        let n = AVAudioFrameCount(file.processingFormat.sampleRate / 10)
        guard let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: n) else { continue }
        // Past the end of a file the track keeps going with silence, as a live track would.
        if (try? file.read(into: buf, frameCount: n)) == nil || buf.frameLength == 0 {
          buf.frameLength = n
          for c in 0..<Int(buf.format.channelCount) { memset(buf.floatChannelData![c], 0, Int(n) * 4) }
        }
        let host = mach_absolute_time()
        track.queue.async { track.push(buf, hostTime: host) }
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
    if let engine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    engine = nil
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
