// The host's ingest socket (`/meetings/ingest?ticket=`), one connection per recording and ticket.
//
// Binary frames: u8 track (0 app, 1 mic), i64 LE index of the first sample, s16 LE samples.
// Text frames out: `meeting.hello` (id, app, title, start, rate), `meeting.end` (sample counts).
// Text frames in: `ack {track, upTo}` (the host holds every sample before upTo; sent right after the
// hello and then every second), `meeting.done` (it has the whole recording: the spool can go) and
// `meeting.stop` (Isaac stopped the recording from Relay). Sending starts at the host's ack, so a
// reconnect resends exactly what the host is missing.
import Foundation

func ingestFrame(track: UInt8, at: Int64, pcm: Data) -> Data {
  var frame = Data([track])
  withUnsafeBytes(of: at.littleEndian) { frame.append(contentsOf: $0) }
  frame.append(pcm)
  return frame
}

/// At most this much audio per frame when catching up (1 s); live frames are ~100 ms.
let maxFrameSamples: Int64 = 16_000
/// Unacked audio allowed in flight per track (10 s), so a slow link does not pile up in memory.
let maxInFlightSamples: Int64 = 160_000

/// Which slice of a track to send next, or nil: from `sent` up to what is written, capped by the
/// frame size and the in-flight window over `acked`.
func nextSlice(sent: Int64, acked: Int64, written: Int64) -> (from: Int64, count: Int64)? {
  let limit = min(written, acked + maxInFlightSamples)
  guard sent < limit else { return nil }
  return (sent, min(maxFrameSamples, limit - sent))
}

final class Uplink {
  enum Event {
    case open
    case closed(String?)
    case done
    case stopRequested
  }

  private let task: URLSessionWebSocketTask
  private let queue = DispatchQueue(label: "uplink")
  private let files: [URL]
  private let written: (Int) -> Int64
  private let ended: () -> SpoolMeta?
  private let hello: [String: Any]
  private let onEvent: (Event) -> Void
  private var readers: [FileHandle?]
  private var acked: [Int64?]
  private var sent: [Int64]
  private var endSent = false
  private var closed = false
  private var timer: DispatchSourceTimer?

  /// `files[i]` is track i's spool file, `written(i)` how many samples it holds, `ended()` the
  /// meta once the recording has ended (then everything is sent and `meeting.end` follows).
  init(url: URL, hello: [String: Any], files: [URL], written: @escaping (Int) -> Int64,
       ended: @escaping () -> SpoolMeta?, onEvent: @escaping (Event) -> Void) {
    task = URLSession.shared.webSocketTask(with: url)
    self.files = files
    self.written = written
    self.ended = ended
    self.hello = hello
    self.onEvent = onEvent
    readers = files.map { try? FileHandle(forReadingFrom: $0) }
    acked = files.map { _ in nil }
    sent = files.map { _ in 0 }
  }

  func start() {
    task.resume()
    sendText(hello)
    receive()
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + 0.1, repeating: 0.1)
    t.setEventHandler { [weak self] in self?.pump() }
    timer = t
    t.resume()
  }

  func close() {
    queue.async { self.finish(nil, notify: false) }
  }

  private func sendText(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) else { return }
    task.send(.string(s)) { [weak self] e in
      if let e { self?.queue.async { self?.finish(e.localizedDescription, notify: true) } }
    }
  }

  private func receive() {
    task.receive { [weak self] result in
      guard let self else { return }
      self.queue.async {
        switch result {
        case .failure(let e):
          self.finish(e.localizedDescription, notify: true)
        case .success(.string(let s)):
          self.heard(s)
          if !self.closed { self.receive() }
        case .success:
          if !self.closed { self.receive() }
        }
      }
    }
  }

  private func heard(_ text: String) {
    guard let data = text.data(using: .utf8),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let t = obj["t"] as? String
    else { return }
    switch t {
    case "ack":
      guard let track = obj["track"] as? Int, track >= 0, track < acked.count, let upTo = (obj["upTo"] as? NSNumber)?.int64Value else { return }
      let first = acked[track] == nil
      acked[track] = upTo
      // The first ack of a connection says where to start; later ones only move the window.
      if first {
        sent[track] = upTo
        if acked.allSatisfy({ $0 != nil }) { onEvent(.open) }
      } else if sent[track] < upTo {
        sent[track] = upTo
      }
    case "meeting.done":
      finish(nil, notify: false)
      onEvent(.done)
    case "meeting.stop":
      onEvent(.stopRequested)
    default:
      break
    }
  }

  private func pump() {
    guard !closed, acked.allSatisfy({ $0 != nil }) else { return }
    for i in files.indices {
      guard let reader = readers[i], let ack = acked[i] else { continue }
      // Several frames per tick when catching up after a reconnect.
      for _ in 0..<8 {
        guard let slice = nextSlice(sent: sent[i], acked: ack, written: written(i)) else { break }
        do {
          try reader.seek(toOffset: UInt64(slice.from * 2))
          guard let pcm = try reader.read(upToCount: Int(slice.count * 2)), !pcm.isEmpty else { break }
          let frame = ingestFrame(track: UInt8(i), at: slice.from, pcm: pcm)
          sent[i] = slice.from + Int64(pcm.count / 2)
          task.send(.data(frame)) { [weak self] e in
            if let e { self?.queue.async { self?.finish(e.localizedDescription, notify: true) } }
          }
        } catch {
          finish("spool read: \(error.localizedDescription)", notify: true)
          return
        }
      }
    }
    if !endSent, let meta = ended(), files.indices.allSatisfy({ sent[$0] >= written($0) }) {
      endSent = true
      var end: [String: Any] = ["t": "meeting.end", "samples": files.indices.map { written($0) }]
      if let at = meta.endedAt { end["endedAt"] = at }
      if let lead = meta.micLeadMs { end["micLeadMs"] = lead }
      if meta.globalTap == true { end["globalTap"] = true }
      sendText(end)
    }
  }

  private func finish(_ error: String?, notify: Bool) {
    guard !closed else { return }
    closed = true
    timer?.cancel()
    timer = nil
    task.cancel(with: .normalClosure, reason: nil)
    for r in readers { try? r?.close() }
    if notify { onEvent(.closed(error)) }
  }
}
