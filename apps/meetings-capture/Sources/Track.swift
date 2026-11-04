// One recorded track: device buffers converted to 16 kHz mono s16 and appended to the spool file
// `<spool>/<id>/<name>.pcm`. The file is the source of truth: the uplink reads from it, so a
// reconnect resends from the host's last ack and a host that is away gets the whole call later.
import AVFoundation
import Foundation

let sampleRate = 16_000
let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(sampleRate), channels: 1, interleaved: true)!

final class Track {
  let id: UInt8
  let name: String
  let url: URL
  let queue: DispatchQueue
  private let handle: FileHandle
  private var converter: AVAudioConverter?
  private let lock = NSLock()
  private var _samples: Int64
  private(set) var firstHostTime: UInt64 = 0
  /// Only touched on `queue`.
  private var closed = false
  /// Non-zero samples per second of the last minute, newest last (the health check reads it).
  private var loudSeconds: [Int] = []
  private var loudInSecond = 0
  private var inSecond = 0

  init(id: UInt8, name: String, url: URL) throws {
    self.id = id
    self.name = name
    self.url = url
    queue = DispatchQueue(label: "track.\(name)")
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil)
    }
    handle = try FileHandle(forWritingTo: url)
    let end = try handle.seekToEnd()
    _samples = Int64(end / 2)
  }

  /// Samples written so far (the uplink sends up to here).
  var samples: Int64 {
    lock.lock()
    defer { lock.unlock() }
    return _samples
  }

  /// Whether the last `seconds` held nothing but digital silence (a pending or denied grant).
  func silent(forLast seconds: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard loudSeconds.count >= seconds else { return false }
    return loudSeconds.suffix(seconds).allSatisfy { $0 == 0 }
  }

  /// Called on `queue` with a copy of the device buffer.
  func push(_ buf: AVAudioPCMBuffer, hostTime: UInt64) {
    if firstHostTime == 0 { firstHostTime = hostTime }
    if converter == nil || converter!.inputFormat != buf.format {
      converter = AVAudioConverter(from: buf.format, to: pcmFormat)
      converter?.downmix = true
    }
    guard let conv = converter else { return }
    let cap = AVAudioFrameCount(Double(buf.frameLength) * Double(sampleRate) / buf.format.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: cap) else { return }
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
    append(out.int16ChannelData![0], count: Int(out.frameLength))
  }

  /// Appends 16 kHz s16 samples. Runs on `queue`; nothing is written once the track is closed.
  func append(_ p: UnsafePointer<Int16>, count n: Int) {
    guard !closed else { return }
    var loud = 0
    for i in 0..<n where p[i] != 0 { loud += 1 }
    handle.write(Data(bytes: p, count: n * 2))
    lock.lock()
    _samples += Int64(n)
    loudInSecond += loud
    inSecond += n
    while inSecond >= sampleRate {
      loudSeconds.append(loudInSecond)
      if loudSeconds.count > 120 { loudSeconds.removeFirst(loudSeconds.count - 120) }
      loudInSecond = 0
      inSecond -= sampleRate
    }
    lock.unlock()
  }

  func close() {
    queue.sync { closed = true }
    try? handle.synchronize()
    try? handle.close()
  }
}

/// `<spool>/<id>/meta.json`: what the host needs to open the recording again after a restart.
struct SpoolMeta: Codable, Equatable {
  var id: String
  var app: String
  var title: String?
  /// Epoch ms.
  var startedAt: Double
  var ended: Bool
  var endedAt: Double?
  /// How much earlier the mic's first buffer arrived than the app track's (from host times).
  var micLeadMs: Double?
  /// The tap could not be scoped to the app's processes and recorded everything else the Mac played.
  var globalTap: Bool?

  static func read(_ dir: URL) -> SpoolMeta? {
    guard let data = try? Data(contentsOf: dir.appendingPathComponent("meta.json")) else { return nil }
    return try? JSONDecoder().decode(SpoolMeta.self, from: data)
  }

  func write(_ dir: URL) {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys]
    guard let data = try? enc.encode(self) else { return }
    try? data.write(to: dir.appendingPathComponent("meta.json"), options: .atomic)
  }
}
