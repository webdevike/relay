// `serve`: the helper as Relay runs it (apps/desktop/src/main/meetings-capture.ts). JSON lines on
// stdin are commands, JSON lines on stdout are events; Relay owns every decision (record a browser
// call or not, which host, the ticket), the helper owns the audio.
//
// Events: ready, call.start {app, browser, title}, call.end {app}, recording {id, app, title,
// startedAt}, pending {id, app, title, startedAt} (a spool from an earlier run that the host has
// not got yet), connected {id}, disconnected {id, error}, health {id, state, detail} (state: ok,
// silent-app, no-mic, or a capture problem: mic-as-call, drift, silent-call, bad-format;
// Capture.swift), stopped {id, seconds, capture} (the capture verdict line), uploaded {id},
// stop.requested {id}, warning {id?, message}, error {message},
// share {id, state: on|off, permission} (someone started or stopped sharing their screen in the
// call, and again while on when the Screen Recording grant changes; permission is only checked,
// never asked for), share.sampled {id, seq, hash} / share.sample.failed {id, seq, reason},
// share.saved {id, seq, n} / share.save.failed {id, seq, reason}.
// Commands: record {app, title?}, connect {id, url}, stop {id}, discard {id}, quit,
// share.sample {id, seq} (capture the shared content now and hold it as seq: only the latest is
// held; answers its 256-bit change hash), share.save {id, seq} (OCR and JPEG the held frame seq
// into the spool as the next shot n, uploaded as `meeting.shot`).
import Foundation

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
  FileHandle.standardOutput.write(data + Data([0x0A]))
}

func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

final class Daemon {
  private let spool: URL
  private let replay: URL?
  private var detector: CallDetector
  private let detect: Bool
  private var recordings: [String: Recording] = [:]
  /// Which app each live recording is for (a call end stops it).
  private var appOf: [String: String] = [:]
  private var uplinks: [String: Uplink] = [:]
  private var warned: [String: Int] = [:]
  /// Recordings whose call shows a screen share, with the permission last reported for it.
  private var sharePermission: [String: Bool] = [:]
  private var timers: [DispatchSourceTimer] = []

  init(spool: URL, replay: URL?, detect: Bool, startAfter: TimeInterval, endAfter: TimeInterval) {
    self.spool = spool
    self.replay = replay
    self.detect = detect
    detector = CallDetector(startAfter: startAfter, endAfter: endAfter)
  }

  func run() -> Never {
    try? FileManager.default.createDirectory(at: spool, withIntermediateDirectories: true)
    emit(["ev": "ready", "version": 1])
    loadLeftovers()
    readStdin()
    every(1) { [weak self] in self?.tickDetect() }
    every(5) { [weak self] in self?.tickHealth() }
    RunLoop.main.run()
    exit(0)
  }

  private func every(_ seconds: Double, _ body: @escaping () -> Void) {
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + seconds, repeating: seconds)
    t.setEventHandler(handler: body)
    t.resume()
    timers.append(t)
  }

  private func loadLeftovers() {
    let dirs = (try? FileManager.default.contentsOfDirectory(at: spool, includingPropertiesForKeys: nil)) ?? []
    for dir in dirs.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
      guard var meta = SpoolMeta.read(dir) else { continue }
      if !meta.ended {
        // The helper died mid-call: what is on disk is the recording.
        meta.ended = true
        let mtime = (try? FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent("app.pcm").path)[.modificationDate] as? Date) ?? Date()
        meta.endedAt = (mtime.timeIntervalSince1970 * 1000).rounded()
        meta.write(dir)
      }
      guard let rec = try? Recording(leftover: dir, meta: meta) else { continue }
      recordings[meta.id] = rec
      var ev: [String: Any] = ["ev": "pending", "id": meta.id, "app": meta.app, "startedAt": meta.startedAt, "seconds": rec.seconds]
      if let t = meta.title { ev["title"] = t }
      emit(ev)
    }
  }

  private func readStdin() {
    let thread = Thread {
      while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let cmd = obj["cmd"] as? String
        else { continue }
        DispatchQueue.main.async { self.handle(cmd, obj) }
      }
      // Relay went away: stop cleanly so the spools are marked ended.
      DispatchQueue.main.async { self.shutdown() }
    }
    thread.start()
  }

  /// Ends every recording (their spools stay for the next run to upload) and exits.
  func shutdown() -> Never {
    for rec in recordings.values { rec.stop() }
    exit(0)
  }

  private func handle(_ cmd: String, _ obj: [String: Any]) {
    switch cmd {
    case "record":
      guard let name = obj["app"] as? String else { return }
      record(app: name, title: obj["title"] as? String)
    case "connect":
      guard let id = obj["id"] as? String, let s = obj["url"] as? String, let url = URL(string: s) else { return }
      connect(id, url)
    case "stop":
      guard let id = obj["id"] as? String else { return }
      stop(id)
    case "discard":
      guard let id = obj["id"] as? String else { return }
      stop(id)
      uplinks.removeValue(forKey: id)?.close()
      recordings[id] = nil
      try? FileManager.default.removeItem(at: spool.appendingPathComponent(id))
    case "share.sample", "share.save":
      guard let id = obj["id"] as? String, let seq = (obj["seq"] as? NSNumber)?.intValue else { return }
      shareCommand(cmd, id, seq)
    case "quit":
      shutdown()
    default:
      emit(["ev": "warning", "message": "unknown command \(cmd)"])
    }
  }

  private func record(app name: String, title: String?) {
    if appOf.values.contains(name) { return }
    let id = UUID().uuidString.lowercased()
    let dir = spool.appendingPathComponent(id)
    let app = meetingApp(named: name)
    let meta = SpoolMeta(id: id, app: name, title: title ?? app.flatMap(windowTitle), startedAt: nowMs(), ended: false)
    do {
      let rec = try Recording(dir: dir, meta: meta, app: app, replay: replay) { [weak self] on in self?.shareChanged(id, on) }
      recordings[id] = rec
      appOf[id] = name
      var ev: [String: Any] = ["ev": "recording", "id": id, "app": name, "startedAt": meta.startedAt]
      if let t = meta.title { ev["title"] = t }
      emit(ev)
    } catch {
      emit(["ev": "error", "message": "could not start recording: \(error)"])
    }
  }

  private func stop(_ id: String) {
    guard let rec = recordings[id], !rec.meta.ended else { return }
    rec.stop()
    appOf[id] = nil
    // The share is no longer watched once the recording stops.
    if let permission = sharePermission.removeValue(forKey: id) {
      emit(["ev": "share", "id": id, "state": "off", "permission": permission])
    }
    var ev: [String: Any] = ["ev": "stopped", "id": id, "seconds": rec.seconds]
    if let c = rec.meta.capture { ev["capture"] = c.line }
    emit(ev)
  }

  private func shareChanged(_ id: String, _ on: Bool) {
    guard let rec = recordings[id], !rec.meta.ended else { return }
    let permission = rec.canCaptureScreen
    sharePermission[id] = on ? permission : nil
    emit(["ev": "share", "id": id, "state": on ? "on" : "off", "permission": permission])
  }

  private func shareCommand(_ cmd: String, _ id: String, _ seq: Int) {
    let sampling = cmd == "share.sample"
    let failed = { (reason: String) in
      emit(["ev": sampling ? "share.sample.failed" : "share.save.failed", "id": id, "seq": seq, "reason": reason])
    }
    guard let rec = recordings[id] else { return failed("no recording \(id)") }
    if sampling {
      rec.sampleShare(seq: seq) { result in
        switch result {
        case .success(let hash): emit(["ev": "share.sampled", "id": id, "seq": seq, "hash": hash])
        case .failure(let e): failed(e.reason)
        }
      }
    } else {
      rec.saveShare(seq: seq) { result in
        switch result {
        case .success(let n): emit(["ev": "share.saved", "id": id, "seq": seq, "n": n])
        case .failure(let e): failed(e.reason)
        }
      }
    }
  }

  private func connect(_ id: String, _ url: URL) {
    guard let rec = recordings[id] else {
      emit(["ev": "warning", "id": id, "message": "no recording \(id)"])
      return
    }
    uplinks.removeValue(forKey: id)?.close()
    var hello: [String: Any] = [
      "t": "meeting.hello", "id": id, "app": rec.meta.app, "startedAt": rec.meta.startedAt,
      "rate": sampleRate, "format": "s16le", "tracks": ["app", "mic"],
    ]
    if let t = rec.meta.title { hello["title"] = t }
    let uplink = Uplink(
      url: url, hello: hello, files: rec.files, written: { rec.written($0) },
      speakers: rec.speakersURL, speakerLines: { rec.speakerLines },
      shots: rec.shotsURL, shotsDir: rec.shotsDir, shotLines: { rec.shotLines },
      ended: { rec.meta.ended ? rec.meta : nil },
      onEvent: { [weak self] event in DispatchQueue.main.async { self?.uplinkEvent(id, event) } })
    uplinks[id] = uplink
    uplink.start()
  }

  private func uplinkEvent(_ id: String, _ event: Uplink.Event) {
    switch event {
    case .open:
      emit(["ev": "connected", "id": id])
    case .closed(let error):
      uplinks[id] = nil
      var ev: [String: Any] = ["ev": "disconnected", "id": id]
      if let error { ev["error"] = error }
      emit(ev)
    case .done:
      uplinks[id] = nil
      recordings[id] = nil
      try? FileManager.default.removeItem(at: spool.appendingPathComponent(id))
      emit(["ev": "uploaded", "id": id])
    case .stopRequested:
      emit(["ev": "stop.requested", "id": id])
      stop(id)
    }
  }

  private func tickDetect() {
    guard detect else { return }
    let using = appsUsingMic(audioProcesses())
    for event in detector.sample(using, at: Date().timeIntervalSince1970) {
      switch event {
      case .start(let name):
        guard let app = meetingApp(named: name) else { continue }
        var ev: [String: Any] = ["ev": "call.start", "app": name, "browser": app.browser]
        if let t = windowTitle(of: app) { ev["title"] = t }
        emit(ev)
      case .end(let name):
        emit(["ev": "call.end", "app": name])
        for (id, app) in appOf where app == name { stop(id) }
      }
    }
  }

  private func tickHealth() {
    for (id, rec) in recordings where !rec.meta.ended {
      rec.refreshTap()
      let shown = warned[id] ?? 0
      for w in rec.warnings.dropFirst(shown) { emit(["ev": "warning", "id": id, "message": w]) }
      warned[id] = rec.warnings.count
      // Screen Recording granted or taken away while someone shares.
      if let was = sharePermission[id], rec.canCaptureScreen != was {
        sharePermission[id] = !was
        emit(["ev": "share", "id": id, "state": "on", "permission": !was])
      }
      if rec.checkHealth() {
        let detail = rec.healthDetail
        emit(["ev": "health", "id": id, "state": rec.health.rawValue, "detail": detail])
        uplinks[id]?.sendHealth(rec.health.rawValue, detail: detail)
      }
    }
  }
}
